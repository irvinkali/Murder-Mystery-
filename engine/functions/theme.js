'use strict';
/* GET /api/theme.css  ->  the loaded pack's skin, as a plain stylesheet.
 *
 * This is what makes the app LOOK like whichever game it is running. Each pack
 * carries a plaintext theme.json next to its encoded bible; every entry in
 * `vars` becomes a CSS custom property on :root, so the engine's own stylesheet
 * re-skins without a single pack name appearing in it.
 *
 * SPOILER-SAFE BY CONSTRUCTION: it reads only theme.json — colours, fonts and
 * decoration. It never touches the encoded pack, so there is nothing here to
 * leak and no party code is needed.
 *
 * Served as a blocking <link> stylesheet rather than applied by script, so the
 * right palette is on screen at first paint and no guest ever sees a flash of
 * the previous game's colours.
 */

const { connect } = require('../lib/store');
const { loadTheme } = require('../lib/theme');

/* Nothing from the theme file is allowed to escape its stylesheet: a stray
 * brace or an injected </style> would break out of the rules we emit. */
function clean(s) { return String(s == null ? '' : s).replace(/[<>{}]/g, ''); }
function cleanName(s) { return String(s == null ? '' : s).replace(/[^a-z0-9-]/gi, ''); }

function build(theme) {
  const t = theme || {};
  const out = [];

  // @import must lead the file, so the font sheet goes first or not at all.
  const fonts = String(t.fonts || '');
  if (/^https:\/\/fonts\.googleapis\.com\//.test(fonts)) {
    out.push(`@import url("${fonts.replace(/["\\]/g, '')}");`);
  }

  const vars = t.vars || {};
  const decls = Object.keys(vars)
    .map((k) => `  --${cleanName(k)}: ${clean(vars[k])};`)
    .filter((l) => !/--:/.test(l));
  if (decls.length) out.push(':root {\n' + decls.join('\n') + '\n}');

  // --body-bg is the one var the engine stylesheet cannot express on its own,
  // because the default background is a gradient layered over a flat colour.
  if (vars['body-bg']) out.push('body { background: var(--body-bg); }');

  for (const rule of (t.css || [])) {
    const r = String(rule == null ? '' : rule);
    // A rule is a selector plus one brace-delimited block; anything else is not
    // a rule we are willing to print into the page.
    if (/^[^{}<>]+\{[^{}<>]*\}$/.test(r.trim())) out.push(r.trim());
  }

  return out.join('\n\n') + '\n';
}

exports.handler = async (event) => {
  connect(event);
  const css = build(loadTheme());
  return {
    statusCode: 200,
    headers: {
      'content-type': 'text/css; charset=utf-8',
      // Short cache: the host may re-skin mid-setup, but no guest's phone
      // should refetch this on every page.
      'cache-control': 'public, max-age=300',
    },
    body: css,
  };
};

exports.build = build; // for tests
