// Chart primitives for the noisebench analysis site.
//
// Plain SVG, no dependencies, no build step. Every form here follows the same
// mark spec: thin marks, 4px rounded data-ends anchored to the baseline, a 2px
// surface gap between adjacent fills, hairline recessive grid, and a hover
// tooltip. Series colors come from CSS custom properties so light and dark are
// one definition each rather than a runtime flip.

const SVG = "http://www.w3.org/2000/svg";

export const el = (name, attrs = {}, parent = null) => {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
};

export const fmt = (x, dp = 3) =>
  x === null || x === undefined || Number.isNaN(x)
    ? "—"
    : Number(x).toFixed(dp);

export const pct = (x, dp = 1) =>
  x === null || x === undefined ? "—" : `${(x * 100).toFixed(dp)}%`;

// Short model label: the slug's vendor prefix is redundant once it is on screen
// twenty times, but keep it where two vendors ship the same short name.
export const shortModel = (name) => name.split("/").pop();

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------
//
// Every quantity on this site is a share of something, so every number on it is
// a percentage and `pct` is the only formatter. `signedPct` is for the handful
// of quantities where direction is the point — how far the panel sits from the
// market, which way a model's two wordings miss each other — and carries an
// explicit + or − so a signed figure is never mistaken for a magnitude.

export const signedPct = (x, dp = 1) =>
  x === null || x === undefined
    ? "—"
    : `${x > 0 ? "+" : x < 0 ? "−" : ""}${(Math.abs(x) * 100).toFixed(dp)}%`;

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export const initTheme = () => {
  const stored = localStorage.getItem("nb-theme");
  if (stored) document.documentElement.setAttribute("data-theme", stored);
  const button = document.querySelector("[data-theme-toggle]");
  if (!button) return;
  const paint = () => {
    const dark = document.documentElement.getAttribute("data-theme")
      ? document.documentElement.getAttribute("data-theme") === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    button.textContent = dark ? "Light" : "Dark";
  };
  paint();
  button.addEventListener("click", () => {
    const dark = document.documentElement.getAttribute("data-theme")
      ? document.documentElement.getAttribute("data-theme") === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("nb-theme", next);
    paint();
    document.dispatchEvent(new CustomEvent("nb-theme"));
  });
};

// ---------------------------------------------------------------------------
// Tooltip — one node reused by every chart on the page.
// ---------------------------------------------------------------------------

let tipNode = null;

const tip = () => {
  if (!tipNode) {
    tipNode = document.createElement("div");
    tipNode.className = "tip";
    document.body.appendChild(tipNode);
  }
  return tipNode;
};

export const showTip = (event, title, rows) => {
  const node = tip();
  node.innerHTML = "";
  const head = document.createElement("div");
  head.className = "tip-title";
  head.textContent = title;
  node.appendChild(head);
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "tip-row";
    const l = document.createElement("span");
    l.textContent = label;
    const v = document.createElement("b");
    v.textContent = value;
    row.append(l, v);
    node.appendChild(row);
  }
  node.classList.add("on");
  moveTip(event);
};

export const moveTip = (event) => {
  const node = tip();
  const pad = 14;
  const rect = node.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + rect.width > window.innerWidth - 8)
    x = event.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8)
    y = event.clientY - rect.height - pad;
  node.style.left = `${Math.max(8, x)}px`;
  node.style.top = `${Math.max(8, y)}px`;
};

export const hideTip = () => tip().classList.remove("on");

const bindTip = (node, title, rows) => {
  node.addEventListener("mouseenter", (e) => showTip(e, title, rows()));
  node.addEventListener("mousemove", moveTip);
  node.addEventListener("mouseleave", hideTip);
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const niceTicks = (min, max, count = 5) => {
  if (min === max) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step)
    out.push(Math.abs(t) < 1e-9 ? 0 : t);
  return out;
};

// Row labels are right-anchored against the plot, so an over-long one runs off
// the left edge of the SVG rather than wrapping. Budget characters against the
// gutter it has to fit in; the untruncated text still reaches the tooltip.
const ELLIPSIS = "…";
const truncate = (text, pixels) => {
  const maxChars = Math.max(8, Math.floor((pixels - 10) / 5.7));
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars - 1).trimEnd()}${ELLIPSIS}`;
};

// A bar with its far end rounded and its baseline end square, so the mark reads
// as anchored rather than floating.
const barPath = (x, y, w, h, r) => {
  const rr = Math.max(0, Math.min(r, Math.abs(w), h / 2));
  if (w >= 0) {
    return `M${x},${y} h${Math.max(0, w - rr)} a${rr},${rr} 0 0 1 ${rr},${rr} v${h - 2 * rr} a${rr},${rr} 0 0 1 ${-rr},${rr} h${-Math.max(0, w - rr)} z`;
  }
  const aw = -w;
  return `M${x},${y} h${-Math.max(0, aw - rr)} a${rr},${rr} 0 0 0 ${-rr},${rr} v${h - 2 * rr} a${rr},${rr} 0 0 0 ${rr},${rr} h${Math.max(0, aw - rr)} z`;
};

// ---------------------------------------------------------------------------
// Horizontal bars — one or more series per row.
//
// `signed: true` anchors bars at zero and colors by sign from the diverging
// pair, for quantities where direction is the point (a model's level effect).
// ---------------------------------------------------------------------------

export const horizontalBars = (mount, options) => {
  const {
    rows,
    series,
    signed = false,
    valueFormat = (v) => fmt(v),
    labelWidth = 150,
    barHeight = signed ? 16 : 11,
    groupGap = 12,
    axisLabel = "",
    tooltip = null,
  } = options;

  mount.innerHTML = "";
  const width = Math.max(mount.clientWidth || 640, 420);
  const rowHeight = series.length * (barHeight + 2) + groupGap;
  const top = 8;
  const bottom = 34;
  const height = top + rows.length * rowHeight + bottom;
  const plotLeft = labelWidth;
  const plotWidth = Math.max(120, width - plotLeft - 56);

  const svg = el("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: "img",
  });

  const values = rows.flatMap((r) => series.map((s) => r[s.key] ?? 0));
  const rawMax = Math.max(...values, 0);
  const rawMin = Math.min(...values, 0);
  const min = signed ? Math.min(rawMin, -rawMax) : 0;
  const max = signed ? Math.max(rawMax, -rawMin) : rawMax;
  const pad = (max - min) * 0.04 || 0.01;
  const lo = signed ? min - pad : 0;
  const hi = max + pad;
  const x = (v) => plotLeft + ((v - lo) / (hi - lo)) * plotWidth;

  // Grid first, so marks sit above it.
  for (const t of niceTicks(lo, hi, 5)) {
    el(
      "line",
      {
        x1: x(t),
        x2: x(t),
        y1: top,
        y2: height - bottom + 6,
        stroke: t === 0 ? "var(--baseline)" : "var(--gridline)",
        "stroke-width": 1,
      },
      svg,
    );
    el(
      "text",
      {
        x: x(t),
        y: height - bottom + 22,
        "text-anchor": "middle",
        "font-size": 11,
        fill: "var(--text-muted)",
      },
      svg,
    ).textContent = valueFormat(t);
  }

  if (axisLabel) {
    el(
      "text",
      {
        x: plotLeft + plotWidth / 2,
        y: height - 2,
        "text-anchor": "middle",
        "font-size": 11,
        fill: "var(--text-muted)",
      },
      svg,
    ).textContent = axisLabel;
  }

  rows.forEach((row, i) => {
    const yTop = top + i * rowHeight + groupGap / 2;

    el(
      "text",
      {
        x: plotLeft - 10,
        y: yTop + (series.length * (barHeight + 2)) / 2,
        "text-anchor": "end",
        "dominant-baseline": "middle",
        "font-size": 12,
        fill: "var(--text-secondary)",
      },
      svg,
    ).textContent = truncate(row.label, labelWidth);

    series.forEach((s, j) => {
      const value = row[s.key] ?? 0;
      const y = yTop + j * (barHeight + 2);
      const zero = signed ? x(0) : x(lo);
      const end = x(value);
      const fill = signed
        ? value < 0
          ? "var(--diverge-neg)"
          : "var(--diverge-pos)"
        : s.color;

      const path = el(
        "path",
        {
          d: barPath(zero, y, end - zero, barHeight, 4),
          fill,
          // 2px surface gap keeps adjacent fills from fusing into one block.
          stroke: "var(--surface-1)",
          "stroke-width": 2,
          "paint-order": "stroke",
        },
        svg,
      );

      bindTip(path, row.label, () =>
        tooltip
          ? tooltip(row)
          : series.map((ss) => [ss.name, valueFormat(row[ss.key] ?? 0)]),
      );

      // Direct value labels only on single-series charts — one number per row.
      // A grouped chart would put forty numbers on screen, which the tooltip
      // and the table view carry better.
      if (series.length === 1) {
        // Sit inside the bar when it is long enough to hold the text, and just
        // past the data end when it is not. `sign` keeps the two mirror cases
        // from needing separate expressions.
        const inside = Math.abs(end - zero) >= 46;
        const sign = value < 0 ? -1 : 1;
        el(
          "text",
          {
            x: end - sign * 6 * (inside ? 1 : -1),
            y: y + barHeight / 2,
            "text-anchor": inside
              ? sign > 0
                ? "end"
                : "start"
              : sign > 0
                ? "start"
                : "end",
            "dominant-baseline": "middle",
            "font-size": 11,
            "font-variant-numeric": "tabular-nums",
            fill: inside ? "#fff" : "var(--text-secondary)",
          },
          svg,
        ).textContent = valueFormat(value);
      }
    });
  });

  mount.appendChild(svg);
  return svg;
};

// ---------------------------------------------------------------------------
// Vertical grouped bars — for ordered bands along the x axis.
// ---------------------------------------------------------------------------

export const groupedColumns = (mount, options) => {
  const {
    rows,
    series,
    valueFormat = (v) => fmt(v, 2),
    axisLabel = "",
    height = 260,
    reference = null,
    // Names the reference line in place, so the reader never has to hunt for
    // what a bare rule across the plot is supposed to mean.
    referenceLabel = "",
    // Baseline the bars grow from. Defaults to zero; a chance-level baseline is
    // the honest anchor when the measure's floor is not zero.
    baseline = 0,
    tooltip = null,
    highlight = null,
  } = options;

  mount.innerHTML = "";
  const width = Math.max(mount.clientWidth || 640, 420);
  // Many categories cannot share a horizontal label row, so they tilt and the
  // plot gives the extra depth back.
  const rotate = rows.length > 8;
  const left = 52;
  const right = 12;
  const top = 12;
  const bottom = rotate ? 108 : 46;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;

  const svg = el("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: "img",
  });

  const values = rows.flatMap((r) => series.map((s) => r[s.key] ?? 0));
  if (reference !== null) values.push(reference);
  const rawMax = Math.max(...values, 0);
  // The smallest value actually plotted, NOT floored at zero — the baseline
  // decision below needs to know whether every bar clears it.
  const rawMin = Math.min(...values);
  const pad = (rawMax - rawMin) * 0.08 || 0.05;
  // Anchoring at the baseline rather than zero keeps a field that all sits
  // between 55% and 83% from being flattened into twenty near-identical bars.
  // Negative values still pull the floor down; the baseline only ever raises
  // it, and only when every bar clears it.
  const floor = rawMin < 0 ? rawMin - pad : 0;
  // Drop slightly below the baseline so a reference line drawn there reads as a
  // line inside the plot with room for its own label, rather than merging into
  // the axis rule.
  const lo = rawMin >= baseline ? baseline - pad * 0.9 : floor;
  const hi = rawMax + pad;
  const y = (v) => top + plotHeight - ((v - lo) / (hi - lo)) * plotHeight;

  for (const t of niceTicks(lo, hi, 5)) {
    el(
      "line",
      {
        x1: left,
        x2: left + plotWidth,
        y1: y(t),
        y2: y(t),
        stroke: t === 0 ? "var(--baseline)" : "var(--gridline)",
        "stroke-width": 1,
      },
      svg,
    );
    el(
      "text",
      {
        x: left - 8,
        y: y(t),
        "text-anchor": "end",
        "dominant-baseline": "middle",
        "font-size": 11,
        fill: "var(--text-muted)",
      },
      svg,
    ).textContent = valueFormat(t);
  }

  if (reference !== null) {
    el(
      "line",
      {
        x1: left,
        x2: left + plotWidth,
        y1: y(reference),
        y2: y(reference),
        stroke: "var(--text-muted)",
        "stroke-width": 2,
      },
      svg,
    );
    if (referenceLabel) {
      // A reference line anchoring the floor sits on the axis, where a label
      // above it would land on the bars; drop it into the gutter instead.
      const atFloor = y(reference) > top + plotHeight - 20;
      el(
        "text",
        {
          x: left + plotWidth,
          y: y(reference) + (atFloor ? 14 : -6),
          "text-anchor": "end",
          "font-size": 11,
          fill: "var(--text-muted)",
          // Halo, so the label survives wherever the marks happen to fall.
          stroke: "var(--surface-1)",
          "stroke-width": 3,
          "paint-order": "stroke",
        },
        svg,
      ).textContent = referenceLabel;
    }
  }

  const bandWidth = plotWidth / rows.length;
  const barWidth = Math.min(30, (bandWidth * 0.66) / series.length);

  rows.forEach((row, i) => {
    const centre = left + bandWidth * (i + 0.5);
    const groupWidth = barWidth * series.length + 2 * (series.length - 1);
    series.forEach((s, j) => {
      const value = row[s.key] ?? 0;
      const bx = centre - groupWidth / 2 + j * (barWidth + 2);
      const zero = y(Math.max(lo, baseline));
      const top0 = Math.min(y(value), zero);
      const h = Math.abs(y(value) - zero);
      const rr = Math.min(4, h / 2);
      // Rounded end away from the baseline, whichever side of zero it is on.
      const d =
        value >= 0
          ? `M${bx},${zero} v${-(h - rr)} a${rr},${rr} 0 0 1 ${rr},${-rr} h${barWidth - 2 * rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${h - rr} z`
          : `M${bx},${zero} v${h - rr} a${rr},${rr} 0 0 0 ${rr},${rr} h${barWidth - 2 * rr} a${rr},${rr} 0 0 0 ${rr},${-rr} v${-(h - rr)} z`;
      const path = el(
        "path",
        {
          d: h > 1 ? d : `M${bx},${zero} h${barWidth} v1 h${-barWidth} z`,
          fill: s.color,
          // Emphasis, not a second hue: everything not highlighted recedes so
          // the named entity carries the eye without adding a colour class.
          "fill-opacity": highlight && row.label !== highlight ? 0.32 : 1,
          stroke: "var(--surface-1)",
          "stroke-width": 2,
          "paint-order": "stroke",
        },
        svg,
      );
      bindTip(path, row.label, () =>
        tooltip
          ? tooltip(row)
          : series.map((ss) => [ss.name, valueFormat(row[ss.key] ?? 0)]),
      );
      void top0;
    });

    el(
      "text",
      {
        x: centre,
        y: height - bottom + (rotate ? 12 : 18),
        "text-anchor": rotate ? "end" : "middle",
        "font-size": 11,
        fill: "var(--text-secondary)",
        transform: rotate
          ? `rotate(-45 ${centre} ${height - bottom + 12})`
          : null,
      },
      svg,
    ).textContent = row.label;
  });

  // Tilted category labels occupy the strip an axis caption would sit in, and
  // a list of model names needs no caption anyway.
  if (axisLabel && !rotate) {
    el(
      "text",
      {
        x: left + plotWidth / 2,
        y: height - 6,
        "text-anchor": "middle",
        "font-size": 11,
        fill: "var(--text-muted)",
      },
      svg,
    ).textContent = axisLabel;
  }

  mount.appendChild(svg);
  return svg;
};

// ---------------------------------------------------------------------------
// Scatter — one series, optional log x for the skewed midpoint axis.
// ---------------------------------------------------------------------------

export const scatter = (mount, options) => {
  const {
    points,
    xLabel = "",
    yLabel = "",
    height = 320,
    logX = false,
    xFormat = (v) => fmt(v, 2),
    yFormat = (v) => fmt(v, 2),
    reference = null,
    // Straight guides in data coordinates, e.g. the y = x line a well-behaved
    // series should sit on. Drawn under the marks and labelled at their end.
    guides = [],
    tooltip = null,
  } = options;

  mount.innerHTML = "";
  const width = Math.max(mount.clientWidth || 640, 420);
  const left = 56;
  const right = 14;
  const top = 14;
  const bottom = 48;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;

  const svg = el("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: "img",
  });

  const tx = (v) => (logX ? Math.log10(Math.max(v, 1e-4)) : v);
  const xs = points.map((p) => tx(p.x));
  const ys = points.map((p) => p.y);
  const xLo = Math.min(...xs);
  const xHi = Math.max(...xs);
  const yPad = (Math.max(...ys) - Math.min(...ys)) * 0.08 || 0.05;
  const yLo = Math.min(...ys) - yPad;
  const yHi = Math.max(...ys) + yPad;
  const xPad = (xHi - xLo) * 0.04 || 0.05;

  const X = (v) =>
    left + ((tx(v) - (xLo - xPad)) / (xHi - xLo + 2 * xPad)) * plotWidth;
  const Y = (v) => top + plotHeight - ((v - yLo) / (yHi - yLo)) * plotHeight;

  for (const t of niceTicks(yLo, yHi, 5)) {
    el(
      "line",
      {
        x1: left,
        x2: left + plotWidth,
        y1: Y(t),
        y2: Y(t),
        stroke: t === 0 ? "var(--baseline)" : "var(--gridline)",
        "stroke-width": 1,
      },
      svg,
    );
    el(
      "text",
      {
        x: left - 8,
        y: Y(t),
        "text-anchor": "end",
        "dominant-baseline": "middle",
        "font-size": 11,
        fill: "var(--text-muted)",
      },
      svg,
    ).textContent = yFormat(t);
  }

  const xTicks = logX
    ? [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1].filter(
        (v) => tx(v) >= xLo - xPad && tx(v) <= xHi + xPad,
      )
    : niceTicks(xLo - xPad, xHi + xPad, 6);
  for (const t of xTicks) {
    el(
      "text",
      {
        x: X(t),
        y: height - bottom + 18,
        "text-anchor": "middle",
        "font-size": 11,
        fill: "var(--text-muted)",
      },
      svg,
    ).textContent = xFormat(t);
  }

  if (reference !== null) {
    el(
      "line",
      {
        x1: left,
        x2: left + plotWidth,
        y1: Y(reference),
        y2: Y(reference),
        stroke: "var(--text-muted)",
        "stroke-width": 2,
      },
      svg,
    );
  }

  for (const g of guides) {
    el(
      "line",
      {
        x1: X(g.x1),
        y1: Y(g.y1),
        x2: X(g.x2),
        y2: Y(g.y2),
        stroke: g.color || "var(--text-muted)",
        "stroke-width": 2,
        "stroke-opacity": 0.55,
      },
      svg,
    );
    if (g.label) {
      el(
        "text",
        {
          x: X(g.x2) - 6,
          y: Y(g.y2) + (g.labelBelow ? 14 : -7),
          "text-anchor": "end",
          "font-size": 11,
          fill: "var(--text-muted)",
        },
        svg,
      ).textContent = g.label;
    }
  }

  for (const p of points) {
    const dot = el(
      "circle",
      {
        cx: X(p.x),
        cy: Y(p.y),
        r: 5,
        fill: p.color || "var(--series-1)",
        "fill-opacity": 0.72,
        // 2px surface ring so overlapping marks stay countable.
        stroke: "var(--surface-1)",
        "stroke-width": 2,
      },
      svg,
    );
    dot.addEventListener("mouseenter", () => dot.setAttribute("r", 7));
    dot.addEventListener("mouseleave", () => dot.setAttribute("r", 5));
    bindTip(dot, p.label, () =>
      tooltip
        ? tooltip(p)
        : [
            [xLabel, xFormat(p.x)],
            [yLabel, yFormat(p.y)],
          ],
    );
  }

  el(
    "text",
    {
      x: left + plotWidth / 2,
      y: height - 6,
      "text-anchor": "middle",
      "font-size": 11,
      fill: "var(--text-muted)",
    },
    svg,
  ).textContent = xLabel;

  el(
    "text",
    {
      x: 14,
      y: top + plotHeight / 2,
      "text-anchor": "middle",
      "font-size": 11,
      fill: "var(--text-muted)",
      transform: `rotate(-90 14 ${top + plotHeight / 2})`,
    },
    svg,
  ).textContent = yLabel;

  mount.appendChild(svg);
  return svg;
};

// ---------------------------------------------------------------------------
// Legend + table view — identity is never carried by color alone.
// ---------------------------------------------------------------------------

export const legend = (mount, series) => {
  mount.innerHTML = "";
  for (const s of series) {
    const key = document.createElement("span");
    key.className = "key";
    const swatch = document.createElement("i");
    swatch.style.background = s.color;
    const label = document.createElement("span");
    label.textContent = s.name;
    key.append(swatch, label);
    mount.appendChild(key);
  }
};

export const renderTable = (mount, columns, rows) => {
  mount.innerHTML = "";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const c of columns) {
    const th = document.createElement("th");
    th.textContent = c.name;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const c of columns) {
      const td = document.createElement("td");
      const value = c.get(row);
      td.textContent = value;
      if (c.numeric !== false) td.className = "num";
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  mount.appendChild(table);
};

/**
 * A table the reader can re-order by any column.
 *
 * Columns declare `get` for what to print and, when the printed string does not
 * sort correctly (a formatted percentage, a signed figure, an em dash for a
 * missing value), `sortValue` for what to sort on. Sorting is stable: equal keys
 * keep the order they arrived in, so re-sorting on a coarse column does not
 * scramble the finer one underneath it.
 *
 * `cellStyle` lets a column paint its own cells — used for the model estimate,
 * where the distance from the market price is easier to read as a wash of colour
 * across a hundred rows than as a second numeric column.
 */
export const sortableTable = (mount, options) => {
  const { columns, rows, sortColumn = 0, descending = false } = options;
  let active = sortColumn;
  let desc = descending;

  const keyOf = (column, row) =>
    column.sortValue ? column.sortValue(row) : column.get(row);

  const paint = () => {
    // Missing values sort to the end whichever direction is asked for: they are
    // not "small", they are absent, and letting them lead a descending sort
    // pushes the rows the reader asked for off the bottom of the screen.
    const decorated = rows.map((row, i) => ({ row, i }));
    const column = columns[active];
    decorated.sort((a, b) => {
      const x = keyOf(column, a.row);
      const y = keyOf(column, b.row);
      const xMissing = x === null || x === undefined || Number.isNaN(x);
      const yMissing = y === null || y === undefined || Number.isNaN(y);
      if (xMissing || yMissing)
        return xMissing === yMissing ? a.i - b.i : xMissing ? 1 : -1;
      const cmp =
        typeof x === "string" || typeof y === "string"
          ? String(x).localeCompare(String(y))
          : x - y;
      return cmp === 0 ? a.i - b.i : desc ? -cmp : cmp;
    });

    mount.innerHTML = "";
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    columns.forEach((c, index) => {
      const th = document.createElement("th");
      if (c.numeric !== false) th.className = "num";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sort";
      // The arrow is decoration; aria-sort on the cell is what a screen reader
      // reads, so the two must not disagree.
      button.textContent = c.name;
      const caret = document.createElement("span");
      caret.setAttribute("aria-hidden", "true");
      caret.textContent = index === active ? (desc ? " ▼" : " ▲") : " ↕";
      caret.className = index === active ? "on" : "off";
      button.appendChild(caret);
      th.setAttribute(
        "aria-sort",
        index === active ? (desc ? "descending" : "ascending") : "none",
      );
      button.addEventListener("click", () => {
        // Re-clicking the active column reverses it; a new column starts in its
        // own natural direction, ascending for text and descending for figures.
        if (index === active) desc = !desc;
        else {
          active = index;
          desc = c.descendingFirst ?? c.numeric !== false;
        }
        paint();
      });
      th.appendChild(button);
      hr.appendChild(th);
    });
    thead.appendChild(hr);

    const tbody = document.createElement("tbody");
    for (const { row } of decorated) {
      const tr = document.createElement("tr");
      for (const c of columns) {
        const td = document.createElement("td");
        td.textContent = c.get(row);
        if (c.numeric !== false) td.className = "num";
        if (c.cellStyle) {
          const style = c.cellStyle(row);
          if (style) td.setAttribute("style", style);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    table.append(thead, tbody);
    mount.appendChild(table);
  };

  paint();
};

/** Wire a "Show data table" button to a table container. */
export const wireTableToggle = (button, container) => {
  button.addEventListener("click", () => {
    const hidden = container.classList.toggle("hidden");
    button.textContent = hidden ? "Show data table" : "Hide data table";
  });
};

/**
 * Re-render charts on resize and on theme change, debounced.
 *
 * Only a change in viewport WIDTH triggers a redraw. Charts size themselves
 * from their container's width and set an explicit height, so a redraw can
 * change the document height, which toggles the scrollbar, which fires another
 * resize — a loop that leaves the renderer busy and the page half-painted.
 * Height changes cannot affect what a chart draws, so ignoring them is both
 * safe and sufficient to break the cycle.
 */
export const onRedraw = (draw) => {
  let timer = null;
  let lastWidth = window.innerWidth;
  const run = () => {
    clearTimeout(timer);
    timer = setTimeout(draw, 120);
  };
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    run();
  });
  document.addEventListener("nb-theme", run);
  draw();
};

export const loadJson = async (name) => {
  const res = await fetch(`data/${name}`);
  if (!res.ok) throw new Error(`Could not load data/${name} (${res.status})`);
  return res.json();
};
