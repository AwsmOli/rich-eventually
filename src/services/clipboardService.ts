class ClipboardService {
  public async copy(text: string): Promise<void> {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return;
    }

    // Fallback for browsers without Clipboard API.
    const textarea = document.createElement("textarea");
    textarea.value = text;
    // Must be visible and in the viewport for execCommand to work.
    textarea.style.cssText =
      "position:fixed;top:0;left:0;opacity:0;pointer-events:none;";
    document.body.append(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

export const clipboardService = new ClipboardService();
