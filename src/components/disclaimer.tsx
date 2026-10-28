import { cn } from '#/lib/utils'

/**
 * The line every recommendation closes on, in the quiet row Connect uses for its legal links;
 * the Disclosures page is where it is said in full.
 */
export function Disclaimer({ className }: { className?: string }) {
  return (
    <footer className={cn('connect-footer', className)}>
      <span>Not financial advice.</span>
      <a href="/disclosures">Disclosures</a>
    </footer>
  )
}
