// USD por 1M tokens. Fuente: precios publicos de cada proveedor al momento de
// escribir esto - pueden cambiar, por eso queda aislado en un solo lugar.
const PRECIOS_USD_POR_1M = {
  'gpt-4o': { input: 2.50, cachedInput: 1.25, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.60 },
  'gpt-4.1-mini': { input: 0.40, cachedInput: 0.10, output: 1.60 },
  // Precio dado por el dueño del negocio (nov-2026): $0,10 entrada / $0,50 salida.
  // No se conoce el precio de entrada cacheada: se usa el de entrada normal, o
  // sea que el costo mostrado es un TECHO (el real sera igual o menor). Cuando
  // se confirme el precio cacheado de OpenAI, cambiar solo cachedInput.
  'gpt-6-luna': { input: 0.10, cachedInput: 0.10, output: 0.50 },
  'claude-haiku-4-5': { input: 1.00, cachedInput: 0.10, output: 5.00 },
  'claude-sonnet-5': { input: 3.00, cachedInput: 0.30, output: 15.00 },
};

function costoUSD(modelo, { promptTokens = 0, cachedTokens = 0, completionTokens = 0 } = {}) {
  const precio = PRECIOS_USD_POR_1M[modelo];
  if (!precio) return null; // modelo desconocido: no se inventa un costo
  const noCacheado = Math.max(0, promptTokens - cachedTokens);
  return (noCacheado * precio.input + cachedTokens * precio.cachedInput + completionTokens * precio.output) / 1_000_000;
}

module.exports = { PRECIOS_USD_POR_1M, costoUSD };
