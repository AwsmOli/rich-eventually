/**
 * Format a number with European notation (1.000.000,00)
 */
export function formatNumberForDisplay(value: number): string {
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * Parse European-formatted number back to a numeric value
 */
export function parseEuropeanNumber(input: string): number {
  // Remove spaces and replace European separators
  const normalized = input
    .replace(/\s/g, "")
    .replace(/\./g, "") // Remove thousand separators
    .replace(/,/g, "."); // Replace decimal comma with period

  return parseFloat(normalized);
}

/**
 * Format number input with real-time European formatting
 */
export function formatNumberInput(value: number): string {
  return formatNumberForDisplay(value);
}
