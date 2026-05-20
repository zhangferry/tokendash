export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(1) + 'M';
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(0) + 'K';
  }
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function formatUSD(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export function formatPercent(n: number): string {
  return n.toFixed(1) + '%';
}

export function formatProjectName(project: string, allProjects?: string[]): string {
  if (!project) return '';

  const getParts = (p: string) => p.split('/').filter(Boolean);
  const parts = getParts(project);
  if (parts.length === 0) return project;

  const baseName = parts[parts.length - 1];

  if (allProjects && allProjects.length > 0) {
    const hasDuplicate = allProjects.some(p => {
      if (p === project) return false;
      const otherParts = getParts(p);
      return otherParts.length > 0 && otherParts[otherParts.length - 1] === baseName;
    });

    if (hasDuplicate && parts.length >= 2) {
      return `${parts[parts.length - 2]}/${baseName}`;
    }
  }

  return baseName;
}
