import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export function Screws() {
  return (
    <>
      <span className="screw left-2.5 top-2.5" aria-hidden />
      <span className="screw right-2.5 top-2.5" aria-hidden />
      <span className="screw screw-b bottom-2.5 left-2.5" aria-hidden />
      <span className="screw screw-b right-2.5 bottom-2.5" aria-hidden />
    </>
  );
}

export function Device({
  title,
  aside,
  children,
  className = "",
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`device ${className}`}>
      <Screws />
      <div className="mb-4 flex min-w-0 flex-wrap items-center gap-3 pl-4 pr-4">
        <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
        {aside ? <div className="ml-auto shrink-0">{aside}</div> : null}
      </div>
      <div className="px-1">{children}</div>
    </section>
  );
}

export function Waveform({
  peaks,
  hot = false,
  fit = false,
  markers,
  decorative = false,
  stretch = false,
  className = "h-16 w-full",
  label = "Waveform",
}: {
  peaks: number[];
  hot?: boolean;
  fit?: boolean;
  markers?: number[];
  decorative?: boolean;
  stretch?: boolean;
  className?: string;
  label?: string;
}) {
  const mid = 24;
  const amp = 20;
  const max = fit ? Math.max(...peaks, 1e-6) : 1;
  const n = peaks.length;
  const xAt = (i: number) => (stretch ? ((i + 0.5) / Math.max(1, n)) * 100 : n <= 1 ? 0 : (i / (n - 1)) * 100);
  const top = peaks.map((p, i) => {
    const y = mid - Math.min(1, p / max) * amp;
    return `${xAt(i).toFixed(2)} ${y.toFixed(2)}`;
  });
  const bottom = [...peaks].reverse().map((p, i) => {
    const y = mid + Math.min(1, p / max) * amp;
    return `${xAt(n - 1 - i).toFixed(2)} ${y.toFixed(2)}`;
  });
  const d = peaks.length ? `M ${top.join(" L ")} L ${bottom.join(" L ")} Z` : "";
  const svgRef = useRef<SVGSVGElement>(null);
  const [markWidth, setMarkWidth] = useState(0.2);
  useEffect(() => {
    const el = svgRef.current;
    if (!el || !stretch) return;
    const fitStroke = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setMarkWidth((1.5 * 100) / w);
    };
    fitStroke();
    const obs = new ResizeObserver(fitStroke);
    obs.observe(el);
    return () => obs.disconnect();
  }, [stretch, n]);
  return (
    <svg
      ref={svgRef}
      viewBox="0 0 100 48"
      preserveAspectRatio={stretch ? "none" : undefined}
      className={`${className} ${hot ? "text-amber" : "text-muted"}`}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : label}
    >
      <line x1="0" x2="100" y1={mid} y2={mid} stroke="currentColor" strokeOpacity="0.28" strokeWidth="0.4" />
      {d ? <path d={d} fill="currentColor" /> : null}
      {markers?.map((mark, index) => (
        <line
          key={`${mark}-${index}`}
          x1={mark * 100}
          x2={mark * 100}
          y1="2"
          y2="46"
          stroke="var(--color-amber)"
          strokeWidth={stretch ? markWidth : 0.45}
        />
      ))}
    </svg>
  );
}

export function Knob({
  label,
  value,
  min,
  max,
  step = 1,
  display,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  display: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const drag = useRef<{ y: number; v: number } | null>(null);
  const span = max - min || 1;
  const arc = Math.min(1, Math.max(0, (value - min) / span));
  const turn = -135 + arc * 270;
  const places = step < 1 ? 1 : 0;

  function setFrom(raw: number) {
    const clamped = Math.min(max, Math.max(min, raw));
    const snapped = Number((Math.round(clamped / step) * step).toFixed(places));
    onChange(snapped);
  }

  return (
    <div className={`flex items-center gap-3 ${disabled ? "opacity-40" : ""}`}>
      <div
        className="knob"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={display}
        data-disabled={disabled ? "true" : "false"}
        style={{ "--turn": `${turn}deg`, "--arc": String(arc) } as CSSProperties}
        onPointerDown={(event) => {
          if (disabled) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { y: event.clientY, v: value };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const delta = drag.current.y - event.clientY;
          setFrom(drag.current.v + (delta / 140) * span);
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          const dir =
            event.key === "ArrowUp" || event.key === "ArrowRight"
              ? 1
              : event.key === "ArrowDown" || event.key === "ArrowLeft"
                ? -1
                : 0;
          if (!dir) return;
          event.preventDefault();
          setFrom(value + dir * step);
        }}
      />
      <span>
        <span className="block font-mono text-xs text-amber">{display}</span>
        <span className="block text-xs text-muted">{label}</span>
      </span>
    </div>
  );
}
