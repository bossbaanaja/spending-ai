import type { MonthSummary } from "../db/repo";

// Stable colors make each category recognizable from one month to the next.
const CATEGORY_COLORS: Record<string, string> = {
  Food: "#ef4444",
  Transport: "#3b82f6",
  Shopping: "#8b5cf6",
  Bills: "#f59e0b",
  Health: "#10b981",
  Entertainment: "#ec4899",
  Transfer: "#06b6d4",
  Other: "#6b7280",
};
const INK_PRIMARY = "#0b0b0b";
const SURFACE = "#fcfcfb";

/**
 * Builds a QuickChart.io URL for the per-category pie chart. Telegram fetches
 * the image itself when we pass the URL to sendPhoto — no rendering here.
 */
export function buildCategoryChartUrl(summary: MonthSummary, monthLabel: string): string {
  const sorted = [...summary.byCategory].sort((a, b) => b.total - a.total);
  const config = {
    type: "pie",
    data: {
      labels: sorted.map((c) => c.category),
      datasets: [
        {
          data: sorted.map((c) => Math.round(c.total * 100) / 100),
          backgroundColor: sorted.map((c) => CATEGORY_COLORS[c.category] ?? CATEGORY_COLORS.Other),
          borderColor: SURFACE,
          borderWidth: 2,
        },
      ],
    },
    options: {
      legend: {
        display: true,
        position: "right",
        labels: { fontColor: INK_PRIMARY, boxWidth: 16, padding: 16 },
      },
      title: {
        display: true,
        text: `Spending by category — ${monthLabel}`,
        fontColor: INK_PRIMARY,
        fontSize: 16,
      },
      plugins: {
        datalabels: { display: false },
      },
    },
  };

  const params = new URLSearchParams({
    c: JSON.stringify(config),
    w: "600",
    h: "400",
    format: "png",
    backgroundColor: SURFACE,
    devicePixelRatio: "2",
  });
  return `https://quickchart.io/chart?${params.toString()}`;
}
