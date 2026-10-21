// The diamond, inline so its four facets follow the theme (brand/atlas-mark.svg).
export function Mark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg className={`mark ${className ?? ""}`} viewBox="300 160 424 704" width={size} height={size} aria-hidden>
      <g stroke="var(--win)" strokeWidth="14" strokeLinejoin="round">
        <polygon points="512,176 318,430 512,506" fill="var(--f1)" />
        <polygon points="512,176 512,506 706,430" fill="var(--f2)" />
        <polygon points="512,848 318,430 512,506" fill="var(--f3)" />
        <polygon points="512,848 512,506 706,430" fill="var(--f4)" />
      </g>
    </svg>
  );
}
