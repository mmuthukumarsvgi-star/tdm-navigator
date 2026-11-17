// Steady-state concentration at time t (h after the start of a dose) for an
// intermittent infusion. f converts (dose unit / L) into the reporting unit.
export const ssConc = (
  D: number, ke: number, vd: number, tInf: number, tau: number, t: number, f = 1
): number => {
  const k = Math.max(ke, 1e-6);
  const R = (f * D) / tInf;
  const peak = (R / (k * vd)) * (1 - Math.exp(-k * tInf)) / (1 - Math.exp(-k * tau));
  const trough = peak * Math.exp(-k * (tau - tInf));
  const tc = ((t % tau) + tau) % tau;
  return tc <= tInf
    ? trough * Math.exp(-k * tc) + (R / (k * vd)) * (1 - Math.exp(-k * tc))
    : peak * Math.exp(-k * (tc - tInf));
};

export const ssPeakTrough = (
  D: number, ke: number, vd: number, tInf: number, tau: number, f = 1
) => {
  const k = Math.max(ke, 1e-6);
  const peak = ((f * D) / (tInf * k * vd)) * (1 - Math.exp(-k * tInf)) / (1 - Math.exp(-k * tau));
  return { peak, trough: peak * Math.exp(-k * (tau - tInf)) };
};
