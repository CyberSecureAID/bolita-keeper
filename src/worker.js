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
  // Primero los que responden BIEN desde los servidores de Cloudflare (los
  // dataseed oficiales suelen limitar/bloquear las IPs de Workers en los picos).
  'https://bsc-rpc.publicnode.com',
  'https://binance.llamarpc.com',
  'https://bsc.drpc.org',
  'https://bsc.blockrazor.xyz',
  'https://1rpc.io/bnb',
  'https://bsc-pokt.nodies.app',
  // Respaldo: los dataseed oficiales (pueden fallar desde Cloudflare).
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io'
];

const MAX_ACCIONES = 8;
/* Cloudflare corta a las 50 peticiones por corrida. Nos guardamos margen:
   si nos acercamos, dejamos el resto de bots para la corrida siguiente.
   Antes reventábamos a mitad y los últimos bots NO se revisaban nunca. */
const TOPE_PETICIONES = 38;
let _peticiones = 0;
const quedaMargen = (cuantas = 1) => (_peticiones + cuantas) <= TOPE_PETICIONES;
const gasto = (cuantas = 1) => { _peticiones += cuantas; };     // máximo de transacciones por corrida (no pasarse de tiempo/gas)
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
/* Precio por PancakeSwap V2 (respaldo cuando V3 no responde). */
const ROUTER_V2 = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const ROUTER_V2_ABI = ['function getAmountsOut(uint256,address[]) view returns (uint256[])'];
/* ══════════════════ MULTICALL ══════════════════
   Una sola petición lee DECENAS de bots de golpe. Sin esto, cada bot costaba
   ~6 peticiones y con 50 usuarios el keeper no daba abasto: Cloudflare corta
   a las 50 peticiones por corrida. Con Multicall, 200 bots caben en 4.       */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
/* ══════════════════ REPARTO EN TURNOS PARALELOS ══════════════════
   Un solo Worker aguanta ~600 bots por corrida. Para miles de usuarios,
   la corrida principal NO trabaja: reparte el trabajo llamando a varias
   copias de sí misma, y cada copia atiende su parte con presupuesto propio.
   Así crecemos sin tocar nada más: solo sube el número de partes.        */
const BOTS_POR_PARTE = 400;      // cuántos bots atiende cada copia
const MAX_PARTES = 30;           // techo de seguridad (30 × 400 = 12.000 bots)
const MC_ABI = [
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[])'
];
const iGrid = new ethers.Interface(ABI);
const iQuoter = new ethers.Interface(QUOTER_ABI);

/** Lanza muchas lecturas en UNA sola petición. Devuelve [{ok, datos}]. */
async function lote(runner, llamadas) {
  if (llamadas.length === 0) return [];
  const mc = new ethers.Contract(MULTICALL3, MC_ABI, runner);
  const salida = [];
  // Troceamos para no mandar paquetes gigantes de una vez.
  const TROZO = 150;   // cuantas más por paquete, más bots caben en una corrida
  for (let i = 0; i < llamadas.length; i += TROZO) {
    const trozo = llamadas.slice(i, i + TROZO);
    if (!quedaMargen()) { trozo.forEach(() => salida.push({ ok: false })); continue; }
    try {
      gasto();
      const res = await mc.aggregate3.staticCall(
        trozo.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))
      );
      res.forEach((r, j) => {
        if (!r.success) { salida.push({ ok: false }); return; }
        try { salida.push({ ok: true, datos: trozo[j].iface.decodeFunctionResult(trozo[j].fn, r.returnData) }); }
        catch (_) { salida.push({ ok: false }); }
      });
    } catch (e) {
      trozo.forEach(() => salida.push({ ok: false }));
    }
  }
  return salida;
}

const llGrid = (fn, args) => ({ target: GRIDBOT, data: iGrid.encodeFunctionData(fn, args), iface: iGrid, fn });
const llQuoter = (params) => ({ target: QUOTER_V3, data: iQuoter.encodeFunctionData('quoteExactInputSingle', [params]), iface: iQuoter, fn: 'quoteExactInputSingle' });

async function quoteV2(runner, tokenIn, tokenOut, amountIn) {
  try {
    const r = new ethers.Contract(ROUTER_V2, ROUTER_V2_ABI, runner);
    const o = await r.getAmountsOut(amountIn, [tokenIn, tokenOut]);
    return o[o.length - 1];
  } catch (_) { return 0n; }
}

async function quoteV3(quoter, tokenIn, tokenOut, amountIn, feeTier) {
  const ft = Number(feeTier) || 0;
  // Si conocemos la comisión del bot, probamos SOLO esa: cada intento extra
  // es una petición, y con varios bots nos quedábamos sin presupuesto.
  const tiers = ft ? [ft] : FEE_TIERS.slice(0, 2);
  for (const fee of tiers) {
    if (!quedaMargen()) return 0n;
    try {
      gasto();
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
  const cMin = new ethers.Interface(['function gasMinOp() view returns (uint256)']);
  const datosTest = cMin.encodeFunctionData('gasMinOp', []);
  for (const url of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(url, 56, { staticNetwork: true });
      await p.getBlockNumber();
      // Prueba REAL: una llamada eth_call al contrato. Muchos RPC responden el
      // número de bloque pero devuelven 403 en las llamadas de lectura; así se
      // descartan aquí y no dejan al keeper "ciego" ante el precio.
      await p.call({ to: GRIDBOT, data: datosTest });
      return p;
    } catch (_) { /* prueba el siguiente */ }
  }
  throw new Error('ningún RPC disponible');
}

/* ================================================================== */
/* Memoria (KV): bloque escaneado + lista de rejillas                  */
/* ================================================================== */

const VACIO = () => ({ lastBlock: 0, grids: [], usuarios: [], descartadas: [] });

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
      usuarios: Array.isArray(e.usuarios) ? e.usuarios : [],
      descartadas: Array.isArray(e.descartadas) ? e.descartadas : [],
      turno: Number(e.turno) || 0
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
  if (!Array.isArray(estado.descartadas)) estado.descartadas = [];
  if (estado.usuarios.length === 0) { log.push('no hay cuentas vigiladas todavía'); return; }

  // 1) Las claves de cada cuenta, todas en UNA petición.
  const res = await lote(cRead.runner, estado.usuarios.map((u) => llGrid('misRejillas', [u])));
  const porUsuario = [];
  res.forEach((r, i) => { if (r.ok) porUsuario.push({ u: estado.usuarios[i], claves: r.datos[0] }); });

  const conocidas = new Set(estado.grids.map((g) => String(claveDeG(g)).toLowerCase()));
  const descartadas = new Set(estado.descartadas.map((x) => String(x).toLowerCase()));

  // 2) Solo las que no conocemos NI hemos descartado antes.
  const nuevas = [];
  for (const { u, claves } of porUsuario) {
    for (const k of claves) {
      const kk = String(k).toLowerCase();
      if (conocidas.has(kk) || descartadas.has(kk)) continue;
      nuevas.push({ u, k });
    }
  }
  if (nuevas.length === 0) { log.push('sin bots nuevos'); return; }

  // 3) Su estado, también en UNA petición (antes era una por bot: se comía todo).
  const rs = await lote(cRead.runner, nuevas.map((x) => llGrid('resumen(bytes32)', [x.k])));
  let alta = 0;
  rs.forEach((r, i) => {
    const { u, k } = nuevas[i];
    if (!r.ok) return;
    const R = r.datos[0];
    if (!R.activa) { estado.descartadas.push(String(k).toLowerCase()); return; }  // no volver a mirarla
    const g = { u, b: R.base, q: R.quote, k };
    if (conocidas.has(String(k).toLowerCase())) return;
    conocidas.add(String(k).toLowerCase());
    estado.grids.push(g); alta++;
  });
  // La lista de descartadas no crece sin límite.
  if (estado.descartadas.length > 400) estado.descartadas = estado.descartadas.slice(-400);
  if (alta) log.push(`${alta} bot(s) nuevo(s) en vigilancia`);
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


/* ================================================================== */
/* Corrida principal                                                   */
/* ================================================================== */

/** Prueba la operación SIN enviarla. Si el contrato la rechaza, nos dice por
 *  qué y no gastamos gas. Antes lanzábamos la transacción a ciegas y fallaba
 *  una y otra vez sin que supiéramos el motivo. */
async function ensayar(cWrite, fn, args) {
  try {
    gasto();
    await cWrite[fn].staticCall(...args);
    return { ok: true };
  } catch (e) {
    const m = String(e?.reason || e?.shortMessage || e?.info?.error?.message || e?.message || e);
    // Un 403/429/timeout NO es un rechazo del contrato: es el RPC fallando. Se
    // relanza para que la corrida reintente con otro RPC (no marca la orden como
    // imposible ni la salta en silencio).
    if (/403|forbidden|429|timeout|rate.?limit|bad response|server response|network|failed to fetch/i.test(m)) {
      throw new Error('RPC ' + m.slice(0, 80));
    }
    return { ok: false, motivo: m.replace(/^execution reverted:?\s*/i, '').slice(0, 120) || 'el contrato lo rechaza' };
  }
}

/** Envía solo si el ensayo dice que va a funcionar. */
async function ejecutarSeguro(cWrite, fn, args, log, et, que) {
  const prueba = await ensayar(cWrite, fn, args);
  if (!prueba.ok) { log.push(`  ✋ ${et}: ${que} NO se puede — ${prueba.motivo}`); return false; }
  gasto(2);
  const tx = await cWrite[fn](...args);
  await tx.wait();
  log.push(`  ✅ ${et}: ${que} · tx ${tx.hash}`);
  return true;
}

/** Decide qué hacer con un bot. Ya tiene TODOS los datos leídos: aquí no se
 *  gasta ni una petición salvo que haya que ejecutar de verdad. */
async function decidir(cWrite, b, gasMin, log, et) {
  const { g, R, modo, obj, niveles } = b;
  const k = claveDeG(g);
  // Se dispara EXACTAMENTE cuando el precio alcanza el nivel del usuario (su
  // precio, sin márgenes añadidos). La tolerancia de slippage del swap la maneja
  // el propio contrato con su slippageBps.
  const supera = (out, min) => out > 0n && out >= BigInt(min);

  if (R.gasSaldoWei < gasMin) { log.push(`  ${et}: SIN GAS — el usuario debe recargar BNB`); return false; }

  // DCA: dispara por tiempo.
  if (modo === 3) {
    const ahora = BigInt(Math.floor(Date.now() / 1000));
    const proxima = BigInt(R.ultimaOpEn) + BigInt(R.intervalo || 0n);
    if (R.intervalo > 0n && ahora >= proxima) {
      return await ejecutarSeguro(cWrite, 'comprarDCA(bytes32)', [k], log, et, `DCA compra #${Number(R.comprasHechas) + 1}`);
    }
    log.push(`  ${et}: DCA — faltan ${Number(proxima - ahora)}s`);
    return false;
  }

  // Take Profit / Stop Loss: cierra la posición entera.
  if (R.tpUnitOut > 0n || R.slUnitOut > 0n) {
    const tp = R.tpUnitOut > 0n && supera(b.outVenta, R.tpUnitOut);
    const sl = R.slUnitOut > 0n && b.outVenta > 0n && b.outVenta <= R.slUnitOut;
    const faltaTP = R.tpUnitOut > 0n && b.outVenta > 0n ? Number((BigInt(R.tpUnitOut) - b.outVenta) * 10000n / BigInt(R.tpUnitOut)) / 100 : null;
    log.push(`  ${et}: TAKE PROFIT — ${tp ? '¡ALCANZADO! vendiendo' : faltaTP === null ? 'esperando' : `falta ${faltaTP.toFixed(2)}% de subida`}${sl ? ' · STOP LOSS alcanzado' : ''}`);
    if (tp || sl) {
      return await ejecutarSeguro(cWrite, 'cerrarPorTPSL', [g.u, g.b, g.q], log, et, `cierre por ${tp ? 'TAKE PROFIT' : 'STOP LOSS'}`);
    }
  }

  // Acumulador: vende todo cuando la posición completa alcanza el objetivo.
  if (modo === 1 && R.posicionBase > 0n) {
    const minObj = R.costeQuote * (10000n + obj) / 10000n;
    const faltaA = minObj > 0n && b.valorPos > 0n ? Number((minObj - b.valorPos) * 10000n / minObj) / 100 : null;
    log.push(`  ${et}: ACUMULADOR — ${faltaA === null ? 'sin datos' : faltaA <= 0 ? '¡objetivo alcanzado!' : `falta ${faltaA.toFixed(2)}% para vender todo`}`);
    if (b.valorPos > 0n && supera(b.valorPos, minObj)) {
      return await ejecutarSeguro(cWrite, 'venderAcumulado(bytes32)', [k], log, et, 'venta total del acumulador');
    }
  }

  // Cuadrículas: la primera que toque.
  let armC = 0, armV = 0;
  for (let i = 0; i < niveles.length; i++) {
    const nv = niveles[i];
    const e = Number(nv.estado);
    if (e === 1) {
      armC++;
      if (supera(b.outCompra, nv.minOutCompra)) {
        if (await ejecutarSeguro(cWrite, 'ejecutar(bytes32,uint256)', [k, i], log, et, `COMPRA nivel ${i}`)) return true;
      }
    } else if (e === 2) {
      armV++;
      if (supera(b.outVenta, nv.minOutVenta)) {
        if (await ejecutarSeguro(cWrite, 'ejecutar(bytes32,uint256)', [k, i], log, et, `VENTA nivel ${i}`)) return true;
      }
    }
  }
  // Cuánto le falta a la cuadrícula más cercana. Así se ve de un vistazo si
  // el bot está "a punto" o muy lejos, en vez de números sueltos.
  const dist = (actual, objetivo) => {
    if (!(objetivo > 0n) || !(actual > 0n)) return null;
    const pct = Number((objetivo - actual) * 10000n / objetivo) / 100;
    return pct;
  };
  let cercaV = null, cercaC = null;
  for (const nv of niveles) {
    const e = Number(nv.estado);
    if (e === 2 && BigInt(nv.minOutVenta) > 0n) {
      const d = dist(b.outVenta, BigInt(nv.minOutVenta));
      if (d !== null && (cercaV === null || d < cercaV)) cercaV = d;
    }
    if (e === 1 && BigInt(nv.minOutCompra) > 0n) {
      const d = dist(b.outCompra, BigInt(nv.minOutCompra));
      if (d !== null && (cercaC === null || d < cercaC)) cercaC = d;
    }
  }
  const txtV = cercaV === null ? '—' : (cercaV <= 0 ? '¡lista!' : `falta ${cercaV.toFixed(2)}% de subida`);
  const txtC = cercaC === null ? '—' : (cercaC <= 0 ? '¡lista!' : `falta ${cercaC.toFixed(2)}% de bajada`);
  log.push(`  ${et}: ${niveles.length} niveles · ${armC} esperan comprar (${txtC}) · ${armV} esperan vender (${txtV})`);
  return false;
}

/** Corrida principal: NO trabaja, reparte.
 *  Mira cuántos bots hay y llama a tantas copias como haga falta, en paralelo.
 *  Cada copia atiende su parte con su propio presupuesto de peticiones. */
async function repartir(env, log) {
  const estado = await cargarEstado(env);
  const total = estado.grids.length;
  const partes = Math.max(1, Math.min(MAX_PARTES, Math.ceil(total / BOTS_POR_PARTE)));

  // Con pocos bots no hace falta repartir: lo hacemos aquí y ahorramos.
  if (partes === 1) { await correr(env, log, 0, 1); return; }

  log.push(`${total} bots → los reparto en ${partes} partes`);
  const base = (env.KEEPER_URL || '').replace(/\/$/, '');
  if (!base) {
    log.push('falta KEEPER_URL: hago lo que pueda en una sola corrida');
    await correr(env, log, 0, 1);
    return;
  }
  const clave = env.ADMIN_TOKEN || '';
  const tareas = [];
  for (let i = 0; i < partes; i++) {
    tareas.push(fetch(`${base}/parte?n=${i}&de=${partes}&key=${encodeURIComponent(clave)}`)
      .then((r) => r.text()).catch((e) => 'parte ' + i + ' falló: ' + e));
  }
  const res = await Promise.all(tareas);
  log.push(...res.map((t, i) => `parte ${i}: ${String(t).slice(0, 90)}`));

  // Un resumen para /estado
  try {
    if (env.KEEPER_KV) await env.KEEPER_KV.put('ultimo', JSON.stringify({
      cuando: new Date().toISOString(), bloque: 0, lastBlock: 0,
      rejillas: total, usuarios: (estado.usuarios || []).length,
      revisados: total, peticiones: partes, acciones: 0,
      log: [`repartido en ${partes} partes de hasta ${BOTS_POR_PARTE} bots`, ...res.map((t, i) => `parte ${i}: ${String(t).slice(0, 90)}`)]
    }));
  } catch (_) {}
}

async function correr(env, log, parte = 0, departes = 1) {
  _peticiones = 0;
  if (!env.KEEPER_PRIVATE_KEY) { log.push('falta KEEPER_PRIVATE_KEY'); return; }

  const provider = await getProvider();
  // Varias llaves separadas por comas: cada parte usa la suya, así las
  // transacciones no hacen cola detrás de una sola wallet.
  const llaves = String(env.KEEPER_PRIVATE_KEY).split(',').map((x) => x.trim()).filter(Boolean);
  const wallet   = new ethers.Wallet(llaves[parte % llaves.length] || llaves[0], provider);
  const cRead    = new ethers.Contract(GRIDBOT, ABI, provider);
  const cWrite   = new ethers.Contract(GRIDBOT, ABI, wallet);

  // Si el RPC elegido se cae justo al pedir el bloque, se prueba con otro antes
  // de rendirse (evita que un RPC flojo tumbe la corrida entera).
  let latest;
  try { latest = await provider.getBlockNumber(); }
  catch (_) { const p2 = await getProvider(); latest = await p2.getBlockNumber(); }
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

  // Cada copia atiende solo los bots que le tocan.
  const todos = estado.grids;
  const mios = departes > 1 ? todos.filter((_, i) => (i % departes) === parte) : todos;
  const total = mios.length;
  let revisados = 0, acciones = 0;

  if (total > 0) {
    // ── TODO de una vez: estado, tipo y niveles de CADA bot en pocas peticiones ──
    const lecturas = [llGrid('gasMinOp', [])];
    for (const g of mios) {
      const k = claveDeG(g);
      lecturas.push(llGrid('resumen(bytes32)', [k]));
      lecturas.push(llGrid('modoDe(bytes32)', [k]));
      lecturas.push(llGrid('nivelesDe', [k]));
    }
    const r1 = await lote(cRead.runner, lecturas);
    const gasMin = r1[0]?.ok ? r1[0].datos[0] : 0n;

    const bots = [];
    mios.forEach((g, i) => {
      const base = 1 + i * 3;
      const R = r1[base]?.ok ? r1[base].datos[0] : null;
      const md = r1[base + 1]?.ok ? r1[base + 1].datos : null;
      const nv = r1[base + 2]?.ok ? r1[base + 2].datos[0] : null;
      if (R) bots.push({ g, R, modo: md ? Number(md[0]) : 0, obj: md ? BigInt(md[1]) : 0n, niveles: nv || [] });
    });

    // ── Los precios de todos los pares, también de una vez ──
    const cotiz = [];
    for (const b of bots) {
      const ft = Number(b.R.feeTier) || 500;
      cotiz.push(llQuoter({ tokenIn: b.g.b, tokenOut: b.g.q, amountIn: b.R.ordenBase, fee: ft, sqrtPriceLimitX96: 0n }));
      cotiz.push(llQuoter({ tokenIn: b.g.q, tokenOut: b.g.b, amountIn: b.R.ordenQuote, fee: ft, sqrtPriceLimitX96: 0n }));
      cotiz.push(llQuoter({ tokenIn: b.g.b, tokenOut: b.g.q, amountIn: b.R.posicionBase > 0n ? b.R.posicionBase : 1n, fee: ft, sqrtPriceLimitX96: 0n }));
    }
    const r2 = await lote(cRead.runner, cotiz);
    bots.forEach((b, i) => {
      b.outVenta = r2[i * 3]?.ok ? r2[i * 3].datos[0] : 0n;
      b.outCompra = r2[i * 3 + 1]?.ok ? r2[i * 3 + 1].datos[0] : 0n;
      b.valorPos = r2[i * 3 + 2]?.ok ? r2[i * 3 + 2].datos[0] : 0n;
    });

    // ── Ahora decidimos, sin gastar ni una petición más ──
    const vivos = [];
    for (const b of bots) {
      revisados++;
      const et = `${b.g.b.slice(0, 6)}/${b.g.q.slice(0, 6)}`;
      if (!b.R.activa) { log.push(`  ${et}: terminada, fuera de la lista`); continue; }
      vivos.push(b.g);
      if (acciones >= MAX_ACCIONES) continue;
      try {
        const hizo = await decidir(cWrite, b, gasMin, log, et);
        if (hizo) acciones++;
      } catch (e) { log.push(`  ⚠ ${et}: ${e?.shortMessage || e?.reason || e?.message || e}`); }
    }
    // Solo quitamos de la lista los bots de NUESTRA parte que ya terminaron.
    if (departes > 1) {
      const muertos = new Set(mios.filter((g) => !vivos.includes(g)).map(idGrid));
      estado.grids = todos.filter((g) => !muertos.has(idGrid(g)));
    } else {
      estado.grids = vivos;
    }
  }

  await guardarEstado(env, estado);
  log.push(`corrida ok: ${revisados}/${total} rejillas revisadas · ${acciones} acciones · ${_peticiones} peticiones`);
  // Guardamos el informe para poder verlo desde el navegador (/estado)
  try {
    if (env.KEEPER_KV) await env.KEEPER_KV.put('ultimo', JSON.stringify({
      cuando: new Date().toISOString(),
      bloque: latest,
      lastBlock: estado.lastBlock,
      rejillas: estado.grids.length,
      usuarios: (estado.usuarios || []).length,
      revisados, peticiones: _peticiones,
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
    try { await repartir(env, log); }
    catch (e) {
      log.push('ERROR: ' + (e?.message || e));
      // IMPRESCINDIBLE: registrar también los fallos, para que /estado NO quede
      // congelado en la última corrida buena. Así se ve el error y su hora real.
      try {
        if (env.KEEPER_KV) await env.KEEPER_KV.put('ultimo', JSON.stringify({
          cuando: new Date().toISOString(), bloque: 0, lastBlock: 0,
          rejillas: '?', usuarios: '?', revisados: 0, peticiones: _peticiones, acciones: 0,
          log: ['⚠ La corrida falló (probable RPC caído). Reintenta en 1 min.', ...log.slice(-30)]
        }));
      } catch (_) {}
    }
    console.log(log.join('\n'));
  },

  // Disparo/diagnóstico manual:  https://tu-worker.workers.dev/run?key=TU_ADMIN_TOKEN
  async fetch(req, env) {
    const url = new URL(req.url);

    // Cada copia atiende su parte del trabajo (la llama la corrida principal).
    if (url.pathname === '/parte') {
      if (env.ADMIN_TOKEN && url.searchParams.get('key') !== env.ADMIN_TOKEN) {
        return new Response('no autorizado', { status: 401 });
      }
      const nParte = Math.max(0, parseInt(url.searchParams.get('n') || '0', 10));
      const deTotal = Math.max(1, parseInt(url.searchParams.get('de') || '1', 10));
      const log = [];
      try { await correr(env, log, nParte, deTotal); }
      catch (e) { log.push('ERROR: ' + (e?.message || e)); }
      return new Response(log.slice(-6).join(' | '), { status: 200 });
    }

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
        `Revisados en esta corrida: ${u.revisados ?? '?'} (peticiones: ${u.peticiones ?? '?'} de 50)`,
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
