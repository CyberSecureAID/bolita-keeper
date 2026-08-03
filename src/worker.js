/**
 * BOLITA — WORKER DEL KEEPER (bot de rejilla)
 * ===========================================
 *
 * Este Worker de Cloudflare vigila, SOLO y sin intervención humana, todas las
 * rejillas de los usuarios en el contrato GridBot, y dispara los pasos cuando
 * el precio cruza un nivel (o cuando toca Take-Profit / Stop-Loss).
 *
 *   1. DESCUBRE rejillas nuevas leyendo el evento RejillaCreada (guarda la
 *      lista en un KV de Cloudflare para no perderla entre corridas).
 *   2. Para cada rejilla activa: mira el precio en Pancake (vía el propio
 *      contrato, `cotizar`) y, si un nivel armado ya se cumple, llama a
 *      `ejecutar`. Si hay TP/SL y se alcanzó, llama a `cerrarPorTPSL`.
 *
 * Se dispara con el cron (ver wrangler.toml, cada minuto). NO expone la llave:
 * la llave del keeper vive en un "secret" de Cloudflare (KEEPER_PRIVATE_KEY).
 *
 * ── SEGURIDAD ──────────────────────────────────────────────────────────
 * El keeper solo puede llamar `ejecutar` y `cerrarPorTPSL`, que el contrato
 * blinda (operan a precios válidos y devuelven al usuario). Aun así:
 *   - La llave va SIEMPRE como secret (KEEPER_PRIVATE_KEY).
 *   - Usa una wallet dedicada SOLO para el keeper, con algo de BNB para gas
 *     (ese gas se lo reembolsa el contrato desde el tanque del usuario).
 *   - No publiques la URL del Worker.
 * ───────────────────────────────────────────────────────────────────────
 *
 * Requiere `ethers` (v6). Cloudflare lo empaqueta solo desde package.json.
 */

import { ethers } from 'ethers';

/* ================================================================== */
/* Configuración fija                                                  */
/* ================================================================== */

const GRIDBOT = '0x4e86430BC2260FE359d1Ea7Eef8B595fB241F93B';

// RPC públicos de BSC (gratis, sin API key). Se prueban en orden.
const RPCS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc-rpc.publicnode.com',
  'https://1rpc.io/bnb'
];

const MAX_ACCIONES = 8;    // máximo de transacciones por corrida (no pasarse de tiempo/gas)
const RANGO_LOGS   = 500;  // tamaño de ventana al buscar eventos (seguro para RPC públicos)

// Solo lo que el keeper necesita del contrato.
const ABI = [
  'function gasMinOp() view returns (uint256)',
  'function resumen(address usuario, address base, address quote) view returns (tuple(address base,address quote,bool activa,uint256 niveles,uint256 armados,uint256 creadaEn,uint256 ultimaOpEn,uint256 comprasHechas,uint256 ventasHechas,uint256 ciclos,uint256 totalOps,uint256 posicionBase,uint256 costeQuote,uint256 volumenQuote,int256 gananciaQuote,uint256 gasSaldoWei,uint256 gasGastadoWei,uint256 ordenQuote,uint256 ordenBase,uint128 tpUnitOut,uint128 slUnitOut,uint16 slippageBps,uint32 cooldownSeg))',
  'function nivelesDe(bytes32 k) view returns (tuple(uint128 minOutCompra,uint128 minOutVenta,uint8 estado)[])',
  'function pathsDe(bytes32 k) view returns (address[] compra, address[] venta)',
  'function ejecutar(address usuario, address base, address quote, uint256 i) external',
  'function cerrarPorTPSL(address usuario, address base, address quote) external',
  'event RejillaCreada(address indexed usuario, address indexed base, address indexed quote, bytes32 clave, uint256 niveles, bool nueva)'
];

// PancakeSwap V3 QuoterV2: precio real del pool que usa el contrato (fee 0.05%).
const QUOTER_V3 = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';
const FEE_V3    = 500;
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)'
];
// Cuánto rinde `amountIn` de tokenIn en tokenOut por V3. Devuelve 0 si no hay pool/liquidez.
async function quoteV3(quoter, tokenIn, tokenOut, amountIn) {
  try {
    const r = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee: FEE_V3, sqrtPriceLimitX96: 0n });
    return r[0];
  } catch { return 0n; }
}

/* ================================================================== */
/* RPC con respaldo                                                    */
/* ================================================================== */

/** Devuelve el primer RPC que responde. */
async function getProvider() {
  for (const url of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(url, 56, { staticNetwork: true });
      await p.getBlockNumber();
      return p;
    } catch (_) { /* prueba el siguiente */ }
  }
  throw new Error('ningún RPC disponible');
}

/* ================================================================== */
/* Memoria (KV): bloque escaneado + lista de rejillas                  */
/* ================================================================== */

async function cargarEstado(env) {
  if (!env.KEEPER_KV) return { lastBlock: 0, grids: [] };
  const raw = await env.KEEPER_KV.get('estado');
  if (!raw) return { lastBlock: 0, grids: [] };
  try {
    const e = JSON.parse(raw);
    return { lastBlock: e.lastBlock || 0, grids: Array.isArray(e.grids) ? e.grids : [] };
  } catch (_) { return { lastBlock: 0, grids: [] }; }
}

async function guardarEstado(env, estado) {
  if (!env.KEEPER_KV) return;
  await env.KEEPER_KV.put('estado', JSON.stringify(estado));
}

function idGrid(g) {
  return `${g.u}-${g.b}-${g.q}`.toLowerCase();
}

/* ================================================================== */
/* Descubrir rejillas nuevas por eventos                               */
/* ================================================================== */

async function descubrir(cRead, estado, latest, log) {
  const filtro = cRead.filters.RejillaCreada();
  const vistos = new Set(estado.grids.map(idGrid));
  let desde = estado.lastBlock + 1;
  let ventana = RANGO_LOGS;

  while (desde <= latest) {
    const hasta = Math.min(desde + ventana - 1, latest);
    let eventos;
    try {
      eventos = await cRead.queryFilter(filtro, desde, hasta);
    } catch (e) {
      // Si el RPC limita el rango, reduce la ventana y reintenta ese mismo tramo.
      if (ventana > 100) { ventana = Math.floor(ventana / 2); continue; }
      log.push(`getLogs ${desde}-${hasta}: ${e?.message || e}`);
      break; // no avanzamos lastBlock más allá de lo escaneado
    }
    for (const ev of eventos) {
      const g = { u: ev.args.usuario, b: ev.args.base, q: ev.args.quote };
      const k = idGrid(g);
      if (!vistos.has(k)) {
        vistos.add(k);
        estado.grids.push(g);
        log.push(`nueva rejilla ${g.b}/${g.q}`);
      }
    }
    estado.lastBlock = hasta;
    desde = hasta + 1;
    ventana = RANGO_LOGS; // restablece la ventana tras un tramo exitoso
  }
}

/* ================================================================== */
/* Procesar una rejilla                                                */
/* ================================================================== */

async function procesarRejilla(cRead, cWrite, g, gasMin, log) {
  const R = await cRead.resumen(g.u, g.b, g.q);
  if (!R.activa) return false;
  if (R.gasSaldoWei < gasMin) return false; // sin gas: el contrato revertiría, no gastamos

  const k = ethers.solidityPackedKeccak256(
    ['address', 'address', 'address'], [g.u, g.b, g.q]
  );
  const quoter = new ethers.Contract(QUOTER_V3, QUOTER_ABI, cRead.runner);

  // 1) TP/SL primero: si se alcanzó, cierra toda la rejilla.
  if (R.tpUnitOut > 0n || R.slUnitOut > 0n) {
    const precioVenta = await quoteV3(quoter, g.b, g.q, R.ordenBase);
    const tp = R.tpUnitOut > 0n && precioVenta >= R.tpUnitOut;
    const sl = R.slUnitOut > 0n && precioVenta <= R.slUnitOut;
    if (tp || sl) {
      const tx = await cWrite.cerrarPorTPSL(g.u, g.b, g.q);
      await tx.wait();
      log.push(`CIERRE ${tp ? 'TP' : 'SL'} ${g.b}/${g.q} de ${g.u} tx ${tx.hash}`);
      return true;
    }
  }

  // 2) Niveles: una cotización por dirección sirve para todos los niveles.
  const niveles = await cRead.nivelesDe(k);
  const outCompra = await quoteV3(quoter, g.q, g.b, R.ordenQuote); // base que rinde ordenQuote (V3)
  const outVenta  = await quoteV3(quoter, g.b, g.q, R.ordenBase);  // quote que rinde ordenBase (V3)

  for (let i = 0; i < niveles.length; i++) {
    const estado = Number(niveles[i].estado);
    if (estado === 1 && outCompra >= niveles[i].minOutCompra) {
      const tx = await cWrite.ejecutar(g.u, g.b, g.q, i);
      await tx.wait();
      log.push(`COMPRA nivel ${i} ${g.b}/${g.q} de ${g.u} tx ${tx.hash}`);
      return true;
    }
    if (estado === 2 && outVenta >= niveles[i].minOutVenta) {
      const tx = await cWrite.ejecutar(g.u, g.b, g.q, i);
      await tx.wait();
      log.push(`VENTA nivel ${i} ${g.b}/${g.q} de ${g.u} tx ${tx.hash}`);
      return true;
    }
  }
  return false;
}

/* ================================================================== */
/* Corrida principal                                                   */
/* ================================================================== */

async function correr(env, log) {
  if (!env.KEEPER_PRIVATE_KEY) { log.push('falta KEEPER_PRIVATE_KEY'); return; }

  const provider = await getProvider();
  const wallet   = new ethers.Wallet(env.KEEPER_PRIVATE_KEY, provider);
  const cRead    = new ethers.Contract(GRIDBOT, ABI, provider);
  const cWrite   = new ethers.Contract(GRIDBOT, ABI, wallet);

  const latest = await provider.getBlockNumber();
  const estado = await cargarEstado(env);
  if (estado.lastBlock === 0) estado.lastBlock = latest; // primera vez: arranca desde ahora

  await descubrir(cRead, estado, latest, log);

  let gasMin = 0n;
  try { gasMin = await cRead.gasMinOp(); } catch (_) {}

  let acciones = 0;
  for (const g of estado.grids) {
    if (acciones >= MAX_ACCIONES) break;
    try {
      if (await procesarRejilla(cRead, cWrite, g, gasMin, log)) acciones++;
    } catch (e) {
      log.push(`rejilla ${g.b}/${g.q} de ${g.u}: ${e?.shortMessage || e?.message || e}`);
    }
  }

  await guardarEstado(env, estado);
  log.push(`corrida ok: ${estado.grids.length} rejillas · ${acciones} acciones`);
}

/* ================================================================== */
/* Entradas: cron (scheduled) y un GET manual protegido               */
/* ================================================================== */

export default {
  async scheduled(event, env, ctx) {
    const log = [];
    try { await correr(env, log); }
    catch (e) { log.push('ERROR: ' + (e?.message || e)); }
    console.log(log.join('\n'));
  },

  // Disparo/diagnóstico manual:  https://tu-worker.workers.dev/run?key=TU_ADMIN_TOKEN
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== '/run') return new Response('ok', { status: 200 });
    if (!env.ADMIN_TOKEN || url.searchParams.get('key') !== env.ADMIN_TOKEN) {
      return new Response('no autorizado', { status: 401 });
    }
    const log = [];
    try { await correr(env, log); }
    catch (e) { log.push('ERROR: ' + (e?.message || e)); }
    return new Response(log.join('\n') || 'sin cambios', {
      status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }
};
