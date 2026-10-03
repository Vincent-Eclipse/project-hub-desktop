// Kleine eigene Utility statt einer zusaetzlichen Abhaengigkeit
// (@electron-toolkit/utils o.ae.) fuer eine einzelne Bedingung.
export const is = {
  dev: process.env.NODE_ENV === 'development' || !!process.env['ELECTRON_RENDERER_URL']
}
