// Gradient control points: security value -> hex color
const SECURITY_GRADIENT_POINTS = [
  { value: -1.0, color: "#A2346F" }, // Purple
  { value: 0.0, color: "#A2346F" }, // Dark red
  { value: 0.1, color: "#812121" }, // Red
  { value: 0.2, color: "#CA1316" }, // Orange
  { value: 0.3, color: "#DE460D" }, // Orange
  { value: 0.4, color: "#E47E07" }, // Yellow
  { value: 0.5, color: "#E4EB8C" }, // Yellow
  { value: 0.6, color: "#84F160" }, // Yellow
  { value: 0.7, color: "#70E7BA" }, // Green
  { value: 0.8, color: "#56DAF3" }, // Blue
  { value: 0.9, color: "#2C85C7" }, // Green
  { value: 1.0, color: "#2E8DF5" }, // Blue
];

// Convert hex to RGB
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 0, g: 0, b: 0 };
}

// Convert RGB to hex
function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((x) => {
        const hex = Math.round(x).toString(16);
        return hex.length === 1 ? "0" + hex : hex;
      })
      .join("")
      .toUpperCase()
  );
}

// Linear interpolation between two colors
function interpolateColor(color1: string, color2: string, t: number): string {
  const rgb1 = hexToRgb(color1);
  const rgb2 = hexToRgb(color2);

  const r = rgb1.r + (rgb2.r - rgb1.r) * t;
  const g = rgb1.g + (rgb2.g - rgb1.g) * t;
  const b = rgb1.b + (rgb2.b - rgb1.b) * t;

  return rgbToHex(r, g, b);
}

export function getEveSecurityColor(securityStatus: number): string {
  // Clamp security value to -1.0 to 1.0 range
  const clamped = Math.max(-1.0, Math.min(1.0, securityStatus));

  // Find the two control points to interpolate between
  for (let i = 0; i < SECURITY_GRADIENT_POINTS.length - 1; i++) {
    const point1 = SECURITY_GRADIENT_POINTS[i];
    const point2 = SECURITY_GRADIENT_POINTS[i + 1];

    if (clamped >= point1.value && clamped <= point2.value) {
      // Interpolation factor (0 to 1)
      const t = (clamped - point1.value) / (point2.value - point1.value);
      return interpolateColor(point1.color, point2.color, t);
    }
  }

  // Fallback (shouldn't reach here if clamping works)
  return SECURITY_GRADIENT_POINTS[0].color;
}

// Kept for backward compatibility if needed
export function getSecurityBand(securityStatus: number): number {
  const clamped = Math.max(0, Math.min(1, securityStatus));
  return Math.floor(clamped * 10);
}
