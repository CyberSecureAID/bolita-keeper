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

const MAX_ACCIONES = 8;     // máximo de transacciones por corrida (no pasarse de tiempo/gas)
const RANGO_LOGS   = 400;   // tamaño de ventana al buscar eventos (seguro para RPC públicos)
const LOOKBACK     = 40000;   // ~33 h: suficiente para hallar bots recientes // al arrancar de cero, mira ~24h atrás para hallar bots ya existentes
const MAX_SCAN     = 9000;    // por corrida (cabe de sobra en el tiempo del Worker) // bloques máximos a escanear por corrida (el resto se sigue en la siguiente)

// Solo lo que el keeper necesita del contrato.
const ABI = [
  'function gasMinOp() view returns (uint256)',
  'function misRejillas(address) view returns (bytes32[])',
  'function resumen(address,address,address) view returns (tuple(address base,address quote,bool activa,uint256 niveles,uint256 armados,uint256 creadaEn,uint256 ultimaOpEn,uint256 comprasHechas,uint256 ventasHechas,uint256 ciclos,uint256 totalOps,uint256 posicionBase,uint256 costeQuote,uint256 volumenQuote,int256 gananciaQuote,uint256 gasSaldoWei,uint256 gasGastadoWei,uint256 ordenQuote,uint256 ordenBase,uint128 tpUnitOut,uint128 slUnitOut,uint16 slippageBps,uint32 cooldownSeg,uint24 feeTier,uint256 intervalo,uint32 comprasMax))',
  'function resumen(bytes32) view returns (tuple(address base,address quote,bool activa,uint256 niveles,uint256 armados,uint256 creadaEn,uint256 ultimaOpEn,uint256 comprasHechas,uint256 ventasHechas,uint256 ciclos,uint256 totalOps,uint256 posicionBase,uint256 costeQuote,uint256 volumenQuote,int256 gananciaQuote,uint256 gasSaldoWei,uint256 gasGastadoWei,uint256 ordenQuote,uint256 ordenBase,uint128 tpUnitOut,uint128 slUnitOut,uint16 slippageBps,uint32 cooldownSeg,uint24 feeTier,uint256 intervalo,uint32 comprasMax))',
  'function modoDe(bytes32) view returns (uint8 modo,uint16 objetivoBps)',
  'function ejecutar(bytes32,uint256) external',
  'function venderAcumulado(bytes32) external',
  'function comprarDCA(bytes32) external',
  'function nivelesDe(bytes32 k) view returns (tuple(uint128 minOutCompra,uint128 minOutVenta,uint8 estado)[])',
  'function pathsDe(bytes32 k) view returns (address[] compra, address[] venta)',
  'function ejecutar(address usuario, address base, address quote, uint256 i) external',
  'function modoDe(address usuario, address base, address quote) view returns (uint8 modo, uint16 objetivoBps)',
  'function venderAcumulado(address usuario, address base, address quote) external',
  'function cerrarPorTPSL(address usuario, address base, address quote) external',
  'event RejillaCreada(address indexed usuario, address indexed base, address indexed quote, bytes32 clave, uint256 niveles, bool nueva)'
];

// PancakeSwap V3 QuoterV2: precio real del pool que usa el contrato (fee 0.05%).
const QUOTER_V3 = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';
const FEE_V3    = 500;
const FEE_TIERS = [500, 2500, 100, 10000];   // mismo orden que mejorFeeTier del front → mismo pool que el bot
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)'
];
// Cuánto rinde `amountIn` de tokenIn en tokenOut por V3. Prueba los tiers en el mismo
// orden que el frontend y usa el primero con liquidez (así coincide con el pool del bot).
async function quoteV3(quoter, tokenIn, tokenOut, amountIn, feeTier) {
  const ft = Number(feeTier) || 0;
  const tiers = ft ? [ft, ...FEE_TIERS.filter((t) => t !== ft)] : FEE_TIERS;
  for (const fee of tiers) {
    try {
      const r = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n });
      if (r[0] > 0n) return r[0];
    } catch (_) {}
  }
  return 0n;
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

const VACIO = () => ({ lastBlock: 0, grids: [], usuarios: [] });

async function cargarEstado(env) {
  if (!env.KEEPER_KV) return VACIO();
  const raw = await env.KEEPER_KV.get('estado');
  if (!raw) return VACIO();
  try {
    const e = JSON.parse(raw);
    return {
      lastBlock: e.lastBlock || 0,
      grids: Array.isArray(e.grids) ? e.grids : [],
      // OJO: sin esta línea se perdía la lista de cuentas en cada corrida.
      usuarios: Array.isArray(e.usuarios) ? e.usuarios : []
    };
  } catch (_) { return VACIO(); }
}

async function guardarEstado(env, estado) {
  if (!env.KEEPER_KV) return;
  await env.KEEPER_KV.put('estado', JSON.stringify(estado));
}

function claveDeG(g) {
  return g.k || ethers.solidityPackedKeccak256(['address', 'address', 'address'], [g.u, g.b, g.q]);
}
function idGrid(g) {
  return claveDeG(g).toLowerCase();
}

/* ================================================================== */
/* Descubrir rejillas nuevas por eventos                               */
/* ================================================================== */

/* ── Descubrir preguntando al contrato (no necesita buscar eventos) ──────────
   Los servidores públicos de BSC no dejan buscar eventos ("limit exceeded"),
   así que preguntamos directamente: "¿qué bots tiene este usuario?".
   La lista de usuarios se guarda en el KV y la web la va alimentando. */
async function descubrirPorUsuarios(cRead, estado, log) {
  if (!Array.isArray(estado.usuarios)) estado.usuarios = [];
  if (estado.usuarios.length === 0) { log.push('no hay usuarios vigilados todavía'); return; }

  const vistos = new Set(estado.grids.map(idGrid));
  for (const u of estado.usuarios) {
    let claves = [];
    try { claves = await cRead.misRejillas(u); }
    catch (e) { log.push(`no pude leer los bots de ${u.slice(0, 8)}: ${e?.shortMessage || e?.message || e}`); continue; }
    for (const k of claves) {
      try {
        const R = await cRead['resumen(bytes32)'](k);
        if (!R.activa) continue;                       // cancelado o terminado
        const g = { u, b: R.base, q: R.quote, k };
        const id = idGrid(g);
        if (vistos.has(id)) continue;
        vistos.add(id);
        estado.grids.push(g);
        log.push(`bot encontrado: ${R.base.slice(0, 8)}/${R.quote.slice(0, 8)} de ${u.slice(0, 8)}`);
      } catch (_) {}
    }
  }
  // Limpiamos los que ya no están activos (para no perder tiempo cada minuto).
  const vivos = [];
  for (const g of estado.grids) {
    try { const R = await cRead['resumen(bytes32)'](claveDeG(g)); if (R.activa) vivos.push(g); }
    catch (_) { vivos.push(g); }
  }
  estado.grids = vivos;
}

async function descubrir(cRead, estado, latest, log) {
  const filtro = cRead.filters.RejillaCreada();
  const vistos = new Set(estado.grids.map(idGrid));
  let fallos = 0;
  // Nunca perseguir historia antigua: si vamos muy atrás, saltamos al presente.
  // (Aquí estaba el fallo: intentaba leer ~1 millón de bloques y no avanzaba nunca.)
  const minimo = Math.max(0, latest - LOOKBACK);
  if (estado.lastBlock < minimo) {
    log.push(`me había quedado muy atrás (${estado.lastBlock}); salto a ${minimo}`);
    estado.lastBlock = minimo;
  }
  let desde = estado.lastBlock + 1;
  const tope = Math.min(latest, desde + MAX_SCAN - 1); // no más de MAX_SCAN bloques por corrida
  let ventana = RANGO_LOGS;

  while (desde <= tope) {
    const hasta = Math.min(desde + ventana - 1, tope);
    let eventos;
    try {
      eventos = await cRead.queryFilter(filtro, desde, hasta);
    } catch (e) {
      // Si el servidor limita el rango, probamos con una ventana más pequeña.
      if (ventana > 50) { ventana = Math.floor(ventana / 2); continue; }
      // Ni con la ventana mínima: cambiamos de servidor y seguimos ADELANTE.
      // Antes se quedaba aquí atascado para siempre sin avanzar ni un bloque.
      log.push(`sin poder leer ${desde}-${hasta} (${e?.message || e}) — sigo adelante`);
      estado.lastBlock = hasta;
      desde = hasta + 1;
      ventana = RANGO_LOGS;
      fallos++;
      if (fallos >= 6) { log.push('demasiados tramos ilegibles: lo dejo para la próxima corrida'); break; }
      continue;
    }
    for (const ev of eventos) {
      const g = { u: ev.args.usuario, b: ev.args.base, q: ev.args.quote, k: ev.args.clave };
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
  const et = `${g.b.slice(0, 6)}/${g.q.slice(0, 6)} de ${g.u.slice(0, 6)}`;
  const k = claveDeG(g);
  const R = await cRead['resumen(bytes32)'](k);
  if (!R.activa) { log.push(`  ${et}: INACTIVA, salto`); return false; }
  if (R.gasSaldoWei < gasMin) { log.push(`  ${et}: SIN GAS (saldo ${R.gasSaldoWei} < min ${gasMin}) — recarga BNB al bot`); return false; }
  const feeTier = Number(R.feeTier) || 0;
  const quoter = new ethers.Contract(QUOTER_V3, QUOTER_ABI, cRead.runner);

  // Tipo de bot: 0 = cuadrícula · 1 = acumulador
  let modo = 0, objBps = 0n;
  try { const md = await cRead['modoDe(bytes32)'](k); modo = Number(md[0]); objBps = BigInt(md[1]); } catch (_) {}

  // DCA (modo 3): dispara por TIEMPO. Compra cuando ya pasó el intervalo desde la última compra.
  if (modo === 3) {
    const ahora = BigInt(Math.floor(Date.now() / 1000));
    const proxima = BigInt(R.ultimaOpEn) + BigInt(R.intervalo || 0n);
    if (R.intervalo > 0n && ahora >= proxima) {
      const tx = await cWrite['comprarDCA(bytes32)'](k);
      await tx.wait();
      log.push(`  ${et}: DCA — COMPRA #${Number(R.comprasHechas) + 1} tx ${tx.hash}`);
      return true;
    }
    log.push(`  ${et}: DCA — próxima compra en ${Number(proxima - ahora)}s (compras ${Number(R.comprasHechas)}${R.comprasMax > 0n ? '/' + Number(R.comprasMax) : ''})`);
    return false;
  }

  // 1) TP/SL primero: si se alcanzó, cierra toda la rejilla.
  if (R.tpUnitOut > 0n || R.slUnitOut > 0n) {
    const precioVenta = await quoteV3(quoter, g.b, g.q, R.ordenBase, feeTier);
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
  const outCompra = await quoteV3(quoter, g.q, g.b, R.ordenQuote, feeTier); // base que rinde ordenQuote (V3)
  const outVenta  = await quoteV3(quoter, g.b, g.q, R.ordenBase, feeTier);  // quote que rinde ordenBase (V3)

  // ACUMULADOR: si la posición completa ya gana el objetivo, vende TODO de golpe.
  if (modo === 1 && R.posicionBase > 0n) {
    const valor = await quoteV3(quoter, g.b, g.q, R.posicionBase, feeTier);
    const minObj = R.costeQuote * (10000n + objBps) / 10000n;
    if (valor > 0n && valor >= minObj) {
      const tx = await cWrite['venderAcumulado(bytes32)'](k);
      await tx.wait();
      log.push(`  ${et}: ACUMULADOR — VENTA TOTAL (valor ${valor} ≥ objetivo ${minObj}) tx ${tx.hash}`);
      return true;
    }
  }

  let armC = 0, armV = 0, ventaLista = false;
  for (const nv of niveles) {
    const e = Number(nv.estado);
    if (e === 1) armC++;
    else if (e === 2) { armV++; if (outVenta >= nv.minOutVenta) ventaLista = true; }
  }
  log.push(`  ${et}: niveles=${niveles.length} compraArm=${armC} ventaArm=${armV} pos=${R.posicionBase} outVenta=${outVenta} outCompra=${outCompra}${outVenta === 0n || outCompra === 0n ? ' ⚠ Quoter=0 (no hay pool con liquidez en ningún tier)' : ''}${ventaLista ? ' → VENTA LISTA' : ''}`);

  for (let i = 0; i < niveles.length; i++) {
    const estado = Number(niveles[i].estado);
    if (estado === 1 && outCompra >= niveles[i].minOutCompra) {
      const tx = await cWrite['ejecutar(bytes32,uint256)'](k, i);
      await tx.wait();
      log.push(`COMPRA nivel ${i} ${g.b}/${g.q} de ${g.u} tx ${tx.hash}`);
      return true;
    }
    if ((modo === 0 || modo === 2) && estado === 2 && outVenta >= niveles[i].minOutVenta) {
      // Smart Grid (modo 0): no disparar si aún no cubre el coste promedio (evita revert).
      // Cash Out (modo 2): vende directo al llegar al objetivo del usuario.
      if (modo === 0 && R.posicionBase > 0n) {
        const costeOrden = R.costeQuote * R.ordenBase / R.posicionBase;
        if (outVenta < costeOrden) continue;
      }
      const tx = await cWrite['ejecutar(bytes32,uint256)'](k, i);
      await tx.wait();
      log.push(`VENTA${modo === 2 ? ' (Cash Out)' : ''} nivel ${i} ${g.b}/${g.q} de ${g.u} tx ${tx.hash}`);
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
  if (estado.lastBlock === 0) estado.lastBlock = Math.max(0, latest - LOOKBACK); // primera vez: mira las últimas ~33 h
  if (estado.lastBlock > latest) estado.lastBlock = Math.max(0, latest - LOOKBACK); // por si quedó adelantado
  // Auto-sanación: si no conoce ningún bot, reescanea la ventana hacia atrás (halla bots que se hayan perdido).
  // Si no conoce ningún bot, mira la ventana reciente (sin irse a la prehistoria).
  if (estado.grids.length === 0) estado.lastBlock = Math.min(estado.lastBlock, Math.max(0, latest - LOOKBACK));

  // 1) Preguntar por los usuarios vigilados (fiable, no depende de eventos).
  await descubrirPorUsuarios(cRead, estado, log);
  // Nota: buscar por eventos no funciona en los servidores públicos de BSC
  // ("limit exceeded"), por eso vamos por la vía directa de arriba.
  estado.lastBlock = latest;

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
  // Guardamos el informe para poder verlo desde el navegador (/estado)
  try {
    if (env.KEEPER_KV) await env.KEEPER_KV.put('ultimo', JSON.stringify({
      cuando: new Date().toISOString(),
      bloque: latest,
      lastBlock: estado.lastBlock,
      rejillas: estado.grids.length,
      usuarios: (estado.usuarios || []).length,
      acciones,
      log: log.slice(-40)
    }));
  } catch (_) {}
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

    // Página de estado: mira aquí para saber si el keeper trabaja.
    if (url.pathname === '/estado') {
      let u = null;
      try { u = env.KEEPER_KV ? JSON.parse((await env.KEEPER_KV.get('ultimo')) || 'null') : null; } catch (_) {}
      if (!u) return new Response('El keeper todavía no ha corrido (o falta el KV).', { status: 200 });
      const hace = Math.round((Date.now() - new Date(u.cuando).getTime()) / 1000);
      const txt = [
        `Última corrida: hace ${hace} s (${u.cuando})`,
        `Bloque actual de la red: ${u.bloque}`,
        `Bloque escaneado: ${u.lastBlock}   (atraso: ${u.bloque - u.lastBlock} bloques)`,
        `Cuentas vigiladas: ${u.usuarios ?? 0}`,
        `Bots encontrados: ${u.rejillas}`,
        `Acciones en la última corrida: ${u.acciones}`,
        '',
        '--- detalle ---',
        ...(u.log || [])
      ].join('\n');
      return new Response(txt, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    // La web avisa al keeper cuando alguien crea un bot: /registrar?u=0xTuWallet
    // Es inofensivo: solo hace que el keeper vigile esa cuenta (su trabajo).
    if (url.pathname === '/registrar') {
      const u = (url.searchParams.get('u') || '').trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(u)) {
        return new Response('dirección no válida', { status: 400, headers: { 'access-control-allow-origin': '*' } });
      }
      try {
        const estado = await cargarEstado(env);
        if (!Array.isArray(estado.usuarios)) estado.usuarios = [];
        const ya = estado.usuarios.some((x) => x.toLowerCase() === u.toLowerCase());
        if (!ya) { estado.usuarios.push(u); await guardarEstado(env, estado); }
        return new Response(ya ? 'ya estaba' : 'registrado', { status: 200, headers: { 'access-control-allow-origin': '*' } });
      } catch (e) {
        return new Response('error', { status: 500, headers: { 'access-control-allow-origin': '*' } });
      }
    }

    if (url.pathname !== '/run') return new Response('ok — usa /estado para ver cómo va', { status: 200 });
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
