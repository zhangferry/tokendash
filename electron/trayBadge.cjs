// electron/trayBadge.js
const { nativeImage } = require('electron');

/**
 * Format token count as compact string for tray badge.
 * Examples: 1234 -> "1.2K", 567890 -> "567.9K", 1500000 -> "1.5M"
 */
function formatTokens(tokens) {
  if (tokens >= 1e6) return (tokens / 1e6).toFixed(1) + 'M';
  if (tokens >= 1e3) return (tokens / 1e3).toFixed(1) + 'K';
  return String(tokens);
}

/**
 * Format cost as compact string for tray badge (max 5 chars).
 * Examples: 1.234 -> "$1.2", 12.5 -> "$12", 0.05 -> "$0.1", 123.4 -> "$123"
 */
function formatCost(cost) {
  if (cost < 0.05) return '$0';
  if (cost < 10) return '$' + cost.toFixed(1);
  if (cost < 100) return '$' + Math.round(cost);
  return '$' + Math.round(cost);
}

// Embedded 22x22 PNG: white circle on transparent background
// Used as a template image — macOS auto-adapts to menu bar appearance
const TRAY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAWElEQVR4nO2U2QkAMAjFnNatOqsFP+2BJxRpBgjh0QrQCiIadGZ4hHgRSjCj0ldvLNWXB6RM5gSSdZIEKfPFzcQ1zy2jeiuFyi8dmER3QkvOpqHefuifZgKh/EKNb7YAbgAAAABJRU5ErkJggg==';

/**
 * Create a macOS tray icon template.
 * setTemplate(true) lets macOS automatically invert colors for light/dark menu bars.
 */
function createBadgeIcon(_text) {
  const img = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_PNG_BASE64}`);
  img.setTemplateImage(true);
  return img;
}

module.exports = { createBadgeIcon, formatCost, formatTokens };
