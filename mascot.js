// Pip — a little globe explorer. Original artwork, drawn inline so it works offline.
// mood: "happy" | "think" | "cheer" | "sleepy" | "wow"
// gear: her level (1-8). Pip picks up kit along the way: a scarf, a backpack, a feather, a gold hat band, and stars.
export const GEAR = [[2, "a scarf"], [3, "a backpack"], [5, "a feather for the hat"], [6, "a gold hat band"], [8, "a trail of stars"]];
export function pip(mood = "happy", size = 120, gear = 1) {
  const pack = gear >= 3 ? `<rect x="7" y="50" width="24" height="38" rx="10" fill="#C98F4E" stroke="#7A5230" stroke-width="3"/>
    <rect x="12" y="62" width="12" height="10" rx="3" fill="#E8B76B" stroke="#7A5230" stroke-width="2"/>` : "";
  const scarf = gear >= 2 ? `<path d="M25 87 q35 17 70 0" stroke="#FF6B5B" stroke-width="8" fill="none" stroke-linecap="round"/>
    <path d="M82 93 q4 9 1 17" stroke="#FF6B5B" stroke-width="7" fill="none" stroke-linecap="round"/>
    <path d="M25 87 q35 17 70 0" stroke="#D94C3D" stroke-width="1.5" fill="none" stroke-dasharray="3 6" opacity=".6"/>` : "";
  const feather = gear >= 5 ? `<path d="M82 27 q13 -17 5 -25 q-10 7 -9 23z" fill="#17A398"/><path d="M83 26 q5 -11 4 -21" stroke="#0F7F76" stroke-width="1.5" fill="none"/>` : "";
  const band = gear >= 6 ? "#FFC845" : "#FF6B5B";
  const star = (x, y, r) => `<path d="M${x} ${y - r} l${r * 0.3} ${r * 0.7} l${r * 0.7} ${r * 0.3} l-${r * 0.7} ${r * 0.3} l-${r * 0.3} ${r * 0.7} l-${r * 0.3} -${r * 0.7} l-${r * 0.7} -${r * 0.3} l${r * 0.7} -${r * 0.3}z" fill="#FFC845"/>`;
  const stars = gear >= 8 ? `<g class="pip-stars">${star(112, 30, 7)}${star(12, 26, 5)}${star(104, 108, 4)}</g>` : "";
  const eyes = {
    happy: `<ellipse cx="46" cy="58" rx="6" ry="7.5" fill="#1E2A44"/><ellipse cx="74" cy="58" rx="6" ry="7.5" fill="#1E2A44"/>
            <circle cx="48" cy="55.5" r="2.2" fill="#fff"/><circle cx="76" cy="55.5" r="2.2" fill="#fff"/>`,
    think: `<ellipse cx="46" cy="58" rx="6" ry="7.5" fill="#1E2A44"/><ellipse cx="74" cy="58" rx="6" ry="7.5" fill="#1E2A44"/>
            <circle cx="49" cy="54.5" r="2.2" fill="#fff"/><circle cx="77" cy="54.5" r="2.2" fill="#fff"/>
            <path d="M38 47 q8 -5 15 -1" stroke="#1E2A44" stroke-width="2.6" fill="none" stroke-linecap="round"/>`,
    cheer: `<path d="M39 59 q7 -9 14 0" stroke="#1E2A44" stroke-width="3.6" fill="none" stroke-linecap="round"/>
            <path d="M67 59 q7 -9 14 0" stroke="#1E2A44" stroke-width="3.6" fill="none" stroke-linecap="round"/>`,
    sleepy: `<path d="M40 59 q6 4 12 0" stroke="#1E2A44" stroke-width="3.2" fill="none" stroke-linecap="round"/>
             <path d="M68 59 q6 4 12 0" stroke="#1E2A44" stroke-width="3.2" fill="none" stroke-linecap="round"/>`,
    wow: `<circle cx="46" cy="57" r="8" fill="#1E2A44"/><circle cx="74" cy="57" r="8" fill="#1E2A44"/>
          <circle cx="49" cy="54" r="2.8" fill="#fff"/><circle cx="77" cy="54" r="2.8" fill="#fff"/>`,
  }[mood];
  const mouth = {
    happy: `<path d="M52 72 q8 8 16 0" stroke="#1E2A44" stroke-width="3" fill="#FF8A7A" stroke-linecap="round"/>`,
    think: `<path d="M54 74 q6 -2 12 1" stroke="#1E2A44" stroke-width="3" fill="none" stroke-linecap="round"/>`,
    cheer: `<path d="M49 70 q11 15 22 0 z" stroke="#1E2A44" stroke-width="3" fill="#FF8A7A" stroke-linejoin="round"/>`,
    sleepy: `<ellipse cx="60" cy="74" rx="3.5" ry="2.5" fill="#1E2A44"/>`,
    wow: `<ellipse cx="60" cy="75" rx="5" ry="6" fill="#1E2A44"/>`,
  }[mood];
  const arms = mood === "cheer"
    ? `<path d="M22 66 q-10 -14 -6 -26" stroke="#2C7FB8" stroke-width="7" fill="none" stroke-linecap="round"/>
       <path d="M98 66 q10 -14 6 -26" stroke="#2C7FB8" stroke-width="7" fill="none" stroke-linecap="round"/>`
    : `<path d="M22 72 q-9 6 -8 15" stroke="#2C7FB8" stroke-width="7" fill="none" stroke-linecap="round"/>
       <path d="M98 70 q8 -2 12 6" stroke="#2C7FB8" stroke-width="7" fill="none" stroke-linecap="round"/>
       <circle cx="114" cy="84" r="9" fill="#DFF4FF" stroke="#7A5230" stroke-width="3.5"/>
       <path d="M108 92 l-6 9" stroke="#7A5230" stroke-width="4.5" stroke-linecap="round"/>`;
  const zzz = mood === "sleepy"
    ? `<text x="92" y="30" font-family="system-ui" font-weight="800" font-size="14" fill="#9AA6BF">z</text>
       <text x="101" y="20" font-family="system-ui" font-weight="800" font-size="10" fill="#9AA6BF">z</text>` : "";
  return `<svg class="pip pip-${mood}" width="${size}" height="${size}" viewBox="0 0 128 128" role="img" aria-label="Pip the globe explorer">
    <ellipse cx="60" cy="120" rx="30" ry="5" fill="#000" opacity=".08"/>
    ${pack}
    ${arms}
    <path d="M44 106 l-3 11 M76 106 l3 11" stroke="#2C7FB8" stroke-width="7" stroke-linecap="round"/>
    <circle cx="60" cy="68" r="40" fill="#46A8E0"/>
    <path d="M30 52 q8 -12 22 -8 q6 8 -2 14 q-8 4 -6 12 q-10 2 -14 -8 q-4 -6 0 -10z" fill="#7BD389"/>
    <path d="M74 38 q14 2 20 14 q-6 4 -12 0 q-6 6 -12 0 q-2 -8 4 -14z" fill="#7BD389"/>
    <path d="M70 92 q10 -6 18 2 q-4 10 -16 8 q-6 -4 -2 -10z" fill="#7BD389"/>
    <circle cx="60" cy="68" r="40" fill="none" stroke="#2C7FB8" stroke-width="3"/>
    <ellipse cx="38" cy="70" rx="6" ry="3.5" fill="#FF8A7A" opacity=".7"/>
    <ellipse cx="82" cy="70" rx="6" ry="3.5" fill="#FF8A7A" opacity=".7"/>
    <g class="pip-eyes">${eyes}</g>${mouth}
    ${scarf}
    <path d="M24 36 q36 -14 72 0 l-6 4 q-30 -10 -60 0z" fill="#C98F4E"/>
    <path d="M34 34 q4 -22 26 -22 q22 0 26 22 q-26 -8 -52 0z" fill="#E8B76B"/>
    <path d="M35 31 q25 -7 50 0" stroke="${band}" stroke-width="4" fill="none"/>
    ${feather}${stars}
    ${zzz}
  </svg>`;
}
