class FormattingService {
  private readonly numberFormat = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  });

  private readonly iskFormat = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  });

  public isk(value: number): string {
    return `${this.iskFormat.format(value)} ISK`;
  }

  public m3(value: number): string {
    return `${this.numberFormat.format(value)} m3`;
  }

  public number(value: number): string {
    return this.numberFormat.format(value);
  }

  public percent(value: number): string {
    return `${(value * 100).toFixed(2)}%`;
  }
}

export const formattingService = new FormattingService();
