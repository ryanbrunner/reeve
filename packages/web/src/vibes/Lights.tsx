/**
 * The rig.
 *
 * Two layers, and which side of the board they fall on is the whole design.
 * Behind: the word walls and the stage lights, which the columns' own
 * translucent fill lets through — that is why a VIBES MODE column is
 * `#0a0c12b3` and not solid. In front: the roaming spots, the scanlines and the
 * glitch bars, which land ON the cards, because a light that never touches what
 * it is lighting reads as wallpaper.
 *
 * All of it is decorative, inert to the pointer, and gone entirely under
 * `prefers-reduced-motion`. The board underneath keeps working.
 */

type Vars = React.CSSProperties;

/** A swinging stage light. `a`/`b` are the ends of its arc. */
function beam(left: string, c: string, a: string, b: string, s: string, dl: string, top = false) {
  return (
    <span
      key={`${left}${c}${top}`}
      className={`sk-beam${top ? ' sk-top' : ''}`}
      style={{ left, '--sk-c': c, '--sk-a': a, '--sk-b': b, '--sk-s': s, '--sk-dl': dl } as Vars}
    />
  );
}

/** A soft blob of colour drifting from one corner to another. */
function roamer(cls: string, c: string, from: [string, string], to: [string, string], s: string, dl: string) {
  return (
    <span
      key={`${cls}${c}`}
      className={cls}
      style={{
        '--sk-c': c,
        '--sk-x0': from[0], '--sk-y0': from[1],
        '--sk-x1': to[0], '--sk-y1': to[1],
        '--sk-s': s, '--sk-dl': dl,
      } as Vars}
    />
  );
}

export function VibesLightsBehind() {
  return (
    <div className="sk-layer" aria-hidden="true" style={{ zIndex: 0 }}>
      {/* Counter-scrolling, at different speeds, so the two never line up. */}
      <div className="sk-words" style={{ top: '21%' }}>
        <span>VIBES MODE ◆ VIBES MODE ◆&nbsp;</span>
        <span>VIBES MODE ◆ VIBES MODE ◆&nbsp;</span>
      </div>
      <div className="sk-words sk-words-b" style={{ top: '58%' }}>
        <span>NO HUMAN ◆ NO HUMAN ◆ NO HUMAN ◆&nbsp;</span>
        <span>NO HUMAN ◆ NO HUMAN ◆ NO HUMAN ◆&nbsp;</span>
      </div>
      <div className="sk-beams">
        {beam('7%', '#ff2d95', '-38deg', '22deg', '3.2s', '-0.4s')}
        {beam('27%', '#00d1ff', '30deg', '-26deg', '2.6s', '-1.1s')}
        {beam('50%', '#ffe600', '-24deg', '26deg', '3.8s', '-2s')}
        {beam('72%', '#2dff7a', '34deg', '-18deg', '2.9s', '-0.7s')}
        {beam('93%', '#9b5cff', '-30deg', '36deg', '3.4s', '-1.6s')}
        {beam('17%', '#ff8a00', '-28deg', '18deg', '4.2s', '-1s', true)}
        {beam('83%', '#00d1ff', '26deg', '-30deg', '3.6s', '-2.4s', true)}
      </div>
      {roamer('sk-pool', '#ff2d95', ['-120px', '520px'], ['760px', '380px'], '5.5s', '-1s')}
      {roamer('sk-pool', '#00d1ff', ['900px', '80px'], ['120px', '300px'], '6.5s', '-3s')}
      {roamer('sk-pool', '#ffe600', ['400px', '600px'], ['1000px', '560px'], '4.8s', '-2s')}
    </div>
  );
}

/** A glitch bar: a slab of colour that difference-blends the board for two frames. */
function glitch(t: string, h: string, c: string, s: string, dl: string) {
  return (
    <span
      key={t + c}
      className="sk-glitch"
      style={{ '--sk-t': t, '--sk-h': h, '--sk-c': c, '--sk-s': s, '--sk-dl': dl } as Vars}
    />
  );
}

export function VibesLightsOver({ flash }: { flash: boolean | null }) {
  return (
    <div className="sk-layer" aria-hidden="true" style={{ zIndex: 30 }}>
      {roamer('sk-spot', '#ff2d95', ['-100px', '120px'], ['1100px', '420px'], '3.8s', '-1.2s')}
      {roamer('sk-spot', '#00d1ff', ['1200px', '500px'], ['80px', '80px'], '4.6s', '-2.8s')}
      {roamer('sk-spot', '#ffe600', ['500px', '-120px'], ['700px', '560px'], '3.1s', '-0.5s')}
      <div className="sk-scan" />
      {glitch('140px', '14px', '#00d1ff', '2.3s', '-0.3s')}
      {glitch('420px', '6px', '#ff2d95', '3.1s', '-1.2s')}
      {glitch('610px', '28px', '#ffe600', '4.3s', '-2.1s')}
      {glitch('300px', '3px', '#ffffff', '1.7s', '-0.9s')}
      {/* Alternated rather than remounted: the two classes are the same blast in
          different colours, and swapping between them is what restarts it. */}
      {flash !== null && <div className={`sk-flash ${flash ? 'sk-flash-a' : 'sk-flash-b'}`} />}
    </div>
  );
}
