// electron/trayBadge.cjs

/**
 * Format token count as compact string for tray badge.
 * Examples: 1234 -> "1.2K", 567890 -> "567.9K", 1500000 -> "1.5M"
 */
function formatTokens(tokens) {
  if (tokens >= 1e6) return (tokens / 1e6).toFixed(1) + 'M';
  if (tokens >= 1e3) return (tokens / 1e3).toFixed(1) + 'K';
  if (tokens > 0) return String(tokens);
  return '0.0M';
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

module.exports = { formatCost, formatTokens };
