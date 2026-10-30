#!/usr/bin/env python3
"""Render the three README screenshots from real captured output.

Nothing here invents text: every body line comes from a captured file or from
the verbatim run log recorded during verification on 2026-10-30.  The renderer
only adds terminal chrome (title bar / footer note) around it.

The one LAN address that appears in the captured probe output is written here
as `***.***.*.***`, and `render()` enforces the same thing for every IPv4
literal it is given: it swaps each character for an asterisk (dots kept) before
laying the line out.  Same character count, so the monospace grid does not
move.  Loopback and wildcard addresses are left readable.  Pass
`redact_ips=False` to `render()` if you ever need an unredacted local copy.
"""
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONO_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

SS = 2                      # supersample factor
BG = (13, 17, 23)
BAR = (22, 27, 34)
EDGE = (48, 54, 61)
FG = (201, 209, 217)
DIM = (110, 118, 129)
COMMENT = (139, 148, 158)
MARK = (88, 166, 255)
KEY = (121, 192, 255)
STR = (165, 214, 255)
NUM = (242, 204, 96)
BOOL = (210, 168, 255)
BAND = (22, 34, 48)

DOTS = [(255, 95, 86), (255, 189, 46), (39, 201, 63)]

IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
KEEP_IP = ("127.", "0.")     # loopback / wildcard stay readable


def redact(line):
    """Swap every IPv4 literal for asterisks, keeping dots and length.

    Every private IPv4 literal becomes `***.***.*.***` — dots are kept and the
    character count is unchanged, so the monospace layout (and therefore the
    rendered width) does not change.
    Loopback / wildcard addresses are kept as-is on purpose: they carry no
    information about anyone's network.
    """
    def mask(m):
        s = m.group(0)
        if s.startswith(KEEP_IP):
            return s
        return "".join("." if c == "." else "*" for c in s)
    return IPV4.sub(mask, line)


def spans(line):
    """Split one line into (text, colour) runs.  Text is never modified here.

    IPv4 redaction happens earlier, in `render()`, so the runs below are already
    the masked text — masked characters stay inside their original token, which
    means they keep its colour.
    """
    s = line.rstrip("\n")
    if not s:
        return [("", FG)]
    stripped = s.lstrip()
    if stripped.startswith("#"):
        return [(s, MARK if stripped.startswith("# ==") else COMMENT)]
    out = []
    # leading whitespace + optional "- "
    m = re.match(r"^(\s*)(-\s+)?", s)
    head = m.group(0)
    rest = s[len(head):]
    if head:
        out.append((head, DIM))
    m2 = re.match(r"^([A-Za-z_][\w.\-]*)(:)( ?)(.*)$", rest)
    if m2:
        out.append((m2.group(1), KEY))
        out.append((m2.group(2) + m2.group(3), FG))
        out.extend(value_spans(m2.group(4)))
        return out
    m3 = re.match(r"^([A-Z][A-Z0-9_]*)(=)(.*)$", rest)
    if m3:
        out.append((m3.group(1), KEY))
        out.append(("=", FG))
        out.extend(value_spans(m3.group(3)))
        return out
    out.extend(value_spans(rest))
    return out


def value_spans(v):
    if not v:
        return [("", FG)]
    runs = []
    pat = re.compile(r"""("[^"]*"|'[^']*'|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?)""")
    pos = 0
    for m in pat.finditer(v):
        if m.start() > pos:
            runs.append((v[pos:m.start()], FG))
        tok = m.group(0)
        if tok[0] in "\"'":
            c = STR
        elif tok in ("true", "false", "null"):
            c = BOOL if tok != "null" else DIM
        else:
            c = NUM
        runs.append((tok, c))
        pos = m.end()
    if pos < len(v):
        runs.append((v[pos:], FG))
    return runs


def render(out, title, lines, footer=None, fs=15, min_w=820, band=(), pad=26,
           redact_ips=True):
    # Mask addresses before anything measures the text, so width and drawing
    # always agree.  redact_ips=False writes an unredacted local copy.
    if redact_ips:
        lines = [redact(line) for line in lines]
    lines = list(lines)
    footer = redact(footer) if (redact_ips and footer) else footer

    f = ImageFont.truetype(MONO, fs * SS)
    ft = ImageFont.truetype(MONO, int(fs * 0.8) * SS)
    ff = ImageFont.truetype(MONO, int(fs * 0.8) * SS)
    adv = f.getlength("M")
    lh = int(fs * 1.55) * SS

    tw = max([f.getlength(t) for t in [title] + list(lines)] + [0])
    bw = max([ff.getlength(footer or "")] + [0])
    inner = int(max(tw, bw, min_w * SS - 2 * pad * SS))
    barh = 44 * SS
    padh = pad * SS
    fh = (34 * SS) if footer else 0
    w = inner + 2 * padh
    h = barh + padh + lh * len(lines) + padh + fh

    im = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, w, barh], fill=BAR)
    d.line([0, barh, w, barh], fill=EDGE, width=SS)
    for i, c in enumerate(DOTS):
        cx = (16 + i * 20) * SS
        d.ellipse([cx, barh // 2 - 6 * SS, cx + 12 * SS, barh // 2 + 6 * SS], fill=c)
    d.text(((80) * SS, barh // 2), title, font=ft, fill=DIM, anchor="lm")

    y = barh + padh
    for i, line in enumerate(lines):
        if i in band:
            d.rectangle([0, y - 3 * SS, w, y + lh - 3 * SS], fill=BAND)
        x = padh
        for txt, col in spans(line):
            if txt:
                d.text((x, y), txt, font=f, fill=col)
                x += adv * len(txt)
        y += lh

    if footer:
        fy = h - fh
        d.line([0, fy, w, fy], fill=EDGE, width=SS)
        d.text((padh, fy + fh // 2), footer, font=ff, fill=DIM, anchor="lm")

    im = im.resize((w // SS, h // SS), Image.LANCZOS)
    im.save(out)
    print("%-28s %5d x %-5d %7d B  %s" % (os.path.basename(out), im.width, im.height,
                                          os.path.getsize(out), out))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    dst = os.path.join(here, "..", "assets")
    dst = os.path.normpath(dst)
    os.makedirs(dst, exist_ok=True)

    # ---- 1. the applied patch row, tail of --dump-config -------------------
    with open("/tmp/shot_dump.txt", encoding="utf-8") as fh:
        dump = fh.read().splitlines()
    block = dump[1291:1308]
    render(os.path.join(dst, "01-patch-applied.png"),
           "dsh --profile web --dump-config   (tail)",
           block,
           footer="verbatim tail of 1308 lines · rc=0 · dsh 0.2.0-rc.2 · our row starts at the marker",
           fs=15, min_w=860, band={3})

    # ---- 2. the model picking the MCP tool on its own ---------------------
    picked = [
        'TOOLCOUNT=32',
        'MCP_TOOLS=["mcp__home_monitor__check_docker","mcp__home_monitor__check_http"'
        ',"mcp__home_monitor__check_ssl","mcp__home_monitor__check_tcp"'
        ',"mcp__home_monitor__monitor_status"]',
        'PICKED=mcp__home_monitor__check_http',
        'TOOLRESULT={"role":"tool","content":"{\\n  \\"ok\\": true, ... \\"status\\": 401, \\"ms\\": 25, \\"bytes\\": 68 ...',
        'DONE_FROM_MODEL',
    ]
    render(os.path.join(dst, "02-model-picks-the-tool.png"),
           "headless turn · what the model chose to call",
           picked,
           footer="log lines as captured (long JSON value elided) · stubbed provider, real MCP bridge",
           fs=13, min_w=1150)

    # ---- 3. one live probe against the running container ------------------
    probe = '''{
  "ok": true,
  "checked": 1,
  "failed": [],
  "results": [
    {
      "ok": true,
      "name": "dsh",
      "url": "http://***.***.*.***:3080/",
      "expected": [ 200, 302, 401 ],
      "status": 401,
      "ms": 19,
      "bytes": 68,
      "truncated": false,
      "contentType": "text/plain; charset=utf-8",
      "server": null,
      "location": null,
      "tlsAuthorized": null
    }
  ]
}'''.splitlines()
    render(os.path.join(dst, "03-live-probe.png"),
           "node probe2.mjs   →   check_http { target: \"dsh\" }",
           probe,
           footer="real run against the live container · 401 is the pass, not the failure · rc=0",
           fs=14, min_w=780)


if __name__ == "__main__":
    sys.exit(main())
