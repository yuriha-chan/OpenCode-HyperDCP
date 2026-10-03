#!/usr/bin/env python3
"""PTY driver for the DCP TUI harness.

`script -qefc` from a non-tty shell cannot drive opencode: opencode swallows the
injected keystrokes. A real pty.fork() master that sets the window size with
TIOCSWINSZ does work (verified manually). This driver uses only the CPython
stdlib (pty/termios/fcntl/os/select) and is invoked by scripts/tui-harness.mjs.

Keystrokes are read from a file, one record per line: "<key>|<delayMs>". The key
field is passed through unchanged (the Node side has already encoded special keys
into escape sequences). The full PTY output is written to the capture file.
"""

import argparse
import codecs
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

TERMINATE = b"\x03\x03"

# Screen-to-PNG metrics. CHAR_W_PX is the advance of DejaVu Sans Mono at
# FONT_SIZE_PX (0.602 em); keep the chromium viewport exactly this size so the
# screenshot has no empty margin to the right.
FONT_SIZE_PX = 14
LINE_H_PX = 15
CHAR_W_PX = FONT_SIZE_PX * 0.602
SCREEN_PAD_PX = 6


def load_steps(path):
    """Read the ordered scenario step list.

    A step is one of:
      {"keys": "...", "delay": 800}   write keys, then wait delay ms (default settle)
      {"waitFor": "marker", "timeout": 5000}  wait until the screen shows marker
      {"screenshot": "name.png"}       render the colored screen to name.png.html
      {"assert": "expected"}           assert expected text is on screen
      {"click": "label", "delay": 800} find label on screen, send an SGR mouse
                                       press+release at its cell, then wait delay
    The Node harness writes the JSON step file; keys are already escape-encoded.
    The png step only writes the HTML next to the capture; the Node side turns it
    into the final PNG with chromium --headless --screenshot.
    """
    if not path:
        return []
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if isinstance(data, dict):
        data = data.get("steps", [])
    return data


def parse_keys(path):
    """Deprecated text keys loader, kept for --keys-file compatibility."""
    records = []
    if not path:
        return records
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            stripped = line.rstrip("\n").strip()
            if not stripped or stripped.startswith("#"):
                continue
            if "|" in stripped:
                key, delay = stripped.split("|", 1)
                delay = delay.strip() or "1200"
            else:
                key, delay = stripped, "1200"
            records.append((key, float(delay) / 1000.0))
    return records


class Screen:
    """Minimal ANSI terminal screen emulator.

    opencode renders with absolute cursor positioning and no newlines, so the
    raw byte stream cannot be searched for a visible marker directly. This
    replays the stream into a rows x cols character grid (mirroring
    ansiToText() in tui-harness.mjs) so waitFor/screenshot can match what the
    user actually sees.
    """

    def __init__(self, cols, rows):
        self.cols = cols
        self.rows = rows
        self.grid = [[" "] * cols for _ in range(rows)]
        self.style = [[self._default_style() for _ in range(cols)] for _ in range(rows)]
        self.row = 0
        self.col = 0
        self.cur = self._default_style()
        self._pending = ""  # bytes of an escape sequence split across feeds()
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")

    @staticmethod
    def _default_style():
        return {"fg": None, "bg": None, "bold": False, "underline": False, "inverse": False}

    def _sgr(self, params):
        if not params:
            params = [0]
        i = 0
        while i < len(params):
            code = params[i]
            if code == 0:
                self.cur = self._default_style()
            elif code == 1:
                self.cur["bold"] = True
            elif code == 4:
                self.cur["underline"] = True
            elif code == 7:
                self.cur["inverse"] = True
            elif code == 22:
                self.cur["bold"] = False
            elif code == 24:
                self.cur["underline"] = False
            elif code == 27:
                self.cur["inverse"] = False
            elif 30 <= code <= 37:
                self.cur["fg"] = code - 30
            elif code == 39:
                self.cur["fg"] = None
            elif 40 <= code <= 47:
                self.cur["bg"] = code - 40
            elif code == 49:
                self.cur["bg"] = None
            elif 90 <= code <= 97:
                self.cur["fg"] = code - 90 + 8
            elif 100 <= code <= 107:
                self.cur["bg"] = code - 100 + 8
            elif code == 38 and i + 1 < len(params) and params[i + 1] == 5 and i + 2 < len(params):
                self.cur["fg"] = params[i + 2]
                i += 2
            elif code == 48 and i + 1 < len(params) and params[i + 1] == 5 and i + 2 < len(params):
                self.cur["bg"] = params[i + 2]
                i += 2
            i += 1

    def _put(self, char):
        if 0 <= self.row < self.rows and 0 <= self.col < self.cols:
            self.grid[self.row][self.col] = char
            self.style[self.row][self.col] = dict(self.cur)
        self.col += 1
        if self.col >= self.cols:
            self.col = 0
            self.row = min(self.rows - 1, self.row + 1)

    def _clear_cell(self, row, col):
        self.grid[row][col] = " "
        self.style[row][col] = self._default_style()

    def feed(self, data):
        text = self._pending + self._decoder.decode(data)
        self._pending = ""
        i = 0
        while i < len(text):
            ch = text[i]
            if ch == "\x1b":
                consumed = self._consume_escape(text, i)
                if consumed is None:
                    # Incomplete escape at the end of this chunk; keep it for
                    # the next feed() so its bytes never render as literal text.
                    self._pending = text[i:]
                    return
                i += consumed
                continue
            if ch == "\n":
                self.row = min(self.rows - 1, self.row + 1)
                self.col = 0
            elif ch == "\r":
                self.col = 0
            elif ch == "\b":
                self.col = max(0, self.col - 1)
            elif ch == "\t":
                self.col = min(self.cols - 1, self.col + (8 - (self.col % 8)))
            elif ch >= " ":
                self._put(ch)
            i += 1

    def _consume_escape(self, text, i):
        """Process the escape sequence at text[i], returning its length.

        Returns None when the sequence is incomplete (the caller must buffer it).
        """
        if i + 1 >= len(text):
            return None
        nxt = text[i + 1]
        if nxt == "[":
            match = re.compile(r"^\x1b\[([0-9:;<=>?]*)([ -/]*)([@-~])").match(text[i:])
            if not match:
                # Either an intermediate/parameter byte not yet final, or a
                # genuinely unknown introducer. If the tail could still grow
                # into a CSI, buffer it; otherwise drop the introducer.
                tail = text[i + 2:]
                if re.match(r"^[0-9:;<=>?\-/]*$", tail):
                    return None
                return 1
            params, final = match.group(1), match.group(3)
            nums = [None if v == "" or not v.isdigit() else int(v) for v in params.split(";")]
            first = nums[0] if nums and nums[0] is not None else 1
            if final in ("H", "f"):
                self.row = (nums[0] or 1) - 1 if nums and nums[0] else 0
                self.col = (nums[1] or 1) - 1 if len(nums) > 1 and nums[1] else 0
            elif final == "A":
                self.row = max(0, self.row - first)
            elif final == "B":
                self.row = min(self.rows - 1, self.row + first)
            elif final == "C":
                self.col = min(self.cols - 1, self.col + first)
            elif final == "D":
                self.col = max(0, self.col - first)
            elif final == "E":
                self.row = min(self.rows - 1, self.row + first)
                self.col = 0
            elif final == "F":
                self.row = max(0, self.row - first)
                self.col = 0
            elif final == "G":
                self.col = first - 1
            elif final == "d":
                self.row = first - 1
            elif final == "J":
                mode = nums[0] or 0 if nums else 0
                if mode in (2, 3):
                    self.grid = [[" "] * self.cols for _ in range(self.rows)]
                    self.style = [[self._default_style() for _ in range(self.cols)] for _ in range(self.rows)]
                elif mode == 0:
                    for c in range(self.col, self.cols):
                        self._clear_cell(self.row, c)
                    for r in range(self.row + 1, self.rows):
                        self.grid[r] = [" "] * self.cols
                        self.style[r] = [self._default_style() for _ in range(self.cols)]
            elif final == "K":
                mode = nums[0] or 0 if nums else 0
                if mode == 0:
                    for c in range(self.col, self.cols):
                        self._clear_cell(self.row, c)
                elif mode == 1:
                    for c in range(0, min(self.col + 1, self.cols)):
                        self._clear_cell(self.row, c)
                elif mode == 2:
                    self.grid[self.row] = [" "] * self.cols
                    self.style[self.row] = [self._default_style() for _ in range(self.cols)]
            elif final == "m":
                self._sgr([0 if v is None else v for v in nums])
            return len(match.group(0))
        if nxt == "]":
            osc = re.compile(r"^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)").match(text[i:])
            if osc:
                return len(osc.group(0))
            # Incomplete OSC (no BEL/ST yet): buffer unless it can't be an OSC.
            if re.match(r"^\x1b\][^\x07\x1b]*$", text[i:]) or re.match(r"^\x1b\][^\x07\x1b]*\x1b$", text[i:]):
                return None
            return 2
        if nxt in ("P", "(", ")", "#"):
            seq = re.compile(r"^\x1b[P()#][^\x1b]*(?:\x1b\\)?").match(text[i:])
            if seq:
                return len(seq.group(0))
            if nxt == "P":
                if not text.endswith("\x1b\\") and "\x1b\\" not in text[i:]:
                    return None
            return 2
        return 2

    def text(self):
        return "\n".join("".join(line).rstrip() for line in self.grid)

    def find(self, needle):
        """Return (row, col) of the first occurrence of needle, or None.

        row/col are 0-based cell coordinates of the first character. Matching is
        done per rendered row so a marker cannot straddle two lines.
        """
        if not needle:
            return None
        for row_index, line in enumerate(self.grid):
            hay = "".join(line)
            col_index = hay.find(needle)
            if col_index >= 0:
                return row_index, col_index
        return None

    def _dominant_bg(self):
        """Most common explicit background color on screen (hex), or None.

        Used as the page background so unpainted cells never show a different
        black than the terminal's real background.
        """
        counts = {}
        for r in range(self.rows):
            for c in range(self.cols):
                st = self.style[r][c]
                val = st["bg"]
                if val is None:
                    continue
                if st["inverse"] and st["fg"] is not None:
                    val = st["fg"]
                counts[val] = counts.get(val, 0) + 1
        if not counts:
            return None
        best = max(counts.items(), key=lambda kv: kv[1])[0]
        base = [
            "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
            "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
        ]
        if 0 <= best < len(base):
            return base[best]
        if best < 232:
            v = best - 16
            step = [0, 95, 135, 175, 215, 255]
            return f"rgb({step[v // 36]},{step[(v % 36) // 6]},{step[v % 6]})"
        level = 8 + (best - 232) * 10
        return f"rgb({level},{level},{level})"

    def to_html(self):
        """Render the colored grid to a standalone HTML page (for chromium --screenshot)."""
        import html as html_mod

        def color(value, is_bg):
            if value is None:
                return None
            base = [
                "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
                "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
            ]
            if 0 <= value < len(base):
                return base[value]
            if value < 16:
                return base[value]
            if value < 232:
                value -= 16
                r = value // 36
                g = (value % 36) // 6
                b = value % 6
                step = [0, 95, 135, 175, 215, 255]
                return f"rgb({step[r]},{step[g]},{step[b]})"
            level = 8 + (value - 232) * 10
            return f"rgb({level},{level},{level})"

        rows_html = []
        for r in range(self.rows):
            cells = []
            run = []  # adjacent default-styled spaces, coalesced into plain text
            for c in range(self.cols):
                ch = self.grid[r][c]
                st = self.style[r][c]
                fg, bg = color(st["fg"], False), color(st["bg"], True)
                if st["inverse"]:
                    fg, bg = (bg or "#e5e5e5"), (fg or "#000000")
                styled = not (fg is None and bg is None and not st["bold"] and not st["underline"])
                if not styled:
                    run.append(ch)
                    continue
                if run:
                    cells.append(html_mod.escape("".join(run)))
                    run = []
                css = ""
                if fg is not None:
                    css += f"color:{fg};"
                if bg is not None:
                    css += f"background:{bg};"
                if st["bold"]:
                    css += "font-weight:bold;"
                if st["underline"]:
                    css += "text-decoration:underline;"
                cells.append(f'<span style="{css}">{html_mod.escape(ch)}</span>')
            if run:
                cells.append(html_mod.escape("".join(run)))
            rows_html.append('<div class="row">' + "".join(cells) + "</div>")
        body = "\n".join(rows_html)
        screen_bg = self._dominant_bg() or "#080808"
        return (
            "<!doctype html><html><head><meta charset=\"utf-8\"><style>"
            f"html,body{{margin:0;background:{screen_bg};}}"
            ".screen{font-family:'DejaVu Sans Mono',monospace;"
            f"font-size:{FONT_SIZE_PX}px;color:#ffffff;"
            "white-space:pre;display:inline-block;"
            f"padding:{SCREEN_PAD_PX}px;}}"
            f".row{{height:{LINE_H_PX}px;line-height:{LINE_H_PX}px;background:{screen_bg};}}"
            "</style></head><body><div class=\"screen\">"
            f"{body}"
            "</div></body></html>"
        )

    def pixel_size(self):
        """Exact pixel size of the rendered screen (for the chromium viewport)."""
        width = int(self.cols * CHAR_W_PX + 2 * SCREEN_PAD_PX + 0.999)
        height = self.rows * LINE_H_PX + 2 * SCREEN_PAD_PX
        return width, height


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--capture", required=True)
    parser.add_argument("--cols", type=int, required=True)
    parser.add_argument("--rows", type=int, required=True)
    parser.add_argument("--startup-ms", type=int, default=4000)
    parser.add_argument("--startup-max-ms", type=int, default=30000)
    parser.add_argument("--wait-for", default="")
    parser.add_argument("--settle-ms", type=int, default=1200)
    parser.add_argument("--timeout-ms", type=int, default=60000)
    parser.add_argument("--keys-file")
    parser.add_argument("--steps-file")
    parser.add_argument("--result-file")
    parser.add_argument("--term", default="xterm-256color")
    parser.add_argument("--respond", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    command = args.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        print("no command given", file=sys.stderr)
        return 2

    keys = parse_keys(args.keys_file)
    steps = load_steps(args.steps_file)

    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.chdir(args.cwd)
        env = dict(os.environ)
        env["TERM"] = args.term
        env["COLUMNS"] = str(args.cols)
        env["LINES"] = str(args.rows)
        try:
            os.execvpe(command[0], command, env)
        except OSError as error:
            sys.stderr.write(f"exec failed: {error}\n")
            os._exit(127)

    size = struct.pack("HHHH", args.rows, args.cols, 0, 0)
    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, size)

    capture = open(args.capture, "wb")
    screen = Screen(args.cols, args.rows)
    started_at = time.monotonic()
    deadline = started_at + args.timeout_ms / 1000.0
    settle_s = args.settle_ms / 1000.0

    # Legacy key-script mode: newline text "key|delayMs" records driven in order.
    # When steps are supplied the ordered step machine takes over.
    pending = list(keys)
    step_mode = bool(steps)
    pending_steps = list(steps)
    last_output_at = started_at
    terminating = False
    terminate_at = None
    cleanup_at = None
    failure = None
    next_action_at = None
    results = []
    png_requests = []

    def drain(timeout):
        readable, _, _ = select.select([master_fd], [], [], timeout)
        if master_fd not in readable:
            return False
        try:
            data = os.read(master_fd, 65536)
        except OSError:
            return False
        if not data:
            return False
        nonlocal last_output_at
        last_output_at = time.monotonic()
        capture.write(data)
        capture.flush()
        screen.feed(data)
        if args.respond:
            respond_to_queries(data)
        return True

    def respond_to_queries(data):
        """Answer terminal capability queries.

        A real terminal replies to these; the bare PTY does not, so opencode
        blocks during startup negotiation and never reads input. Replies mirror
        what an xterm-compatible terminal would send.
        """
        replies = bytearray()
        # Device Status Report (cursor position): ESC[6n -> ESC[<row>;<col>R
        if b"\x1b[6n" in data:
            replies += f"\x1b[{args.rows};{args.cols}R".encode("ascii")
        # DECRQM: ESC[?<n>$p -> report mode as reset (2)
        for match in re.finditer(rb"\x1b\[\?(\d+)\$p", data):
            replies += f"\x1b[?{match.group(1).decode()};2$y".encode("ascii")
        # Kitty keyboard: ESC[?u -> ESC[?0u (no progressive enhancement)
        if b"\x1b[?u" in data:
            replies += b"\x1b[?0u"
        # Primary DA / XTVERSION probe
        if b"\x1b[>0q" in data:
            replies += b"\x1bP>|xterm 370\x1b\\"
        # OSC 10 (fg) / OSC 11 (bg) / OSC 4;<n> (palette) color queries
        if b"\x1b]10;?" in data:
            replies += b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\"
        if b"\x1b]11;?" in data:
            replies += b"\x1b]11;rgb:0000/0000/0000\x1b\\"
        for match in re.finditer(rb"\x1b\]4;(\d+);\?", data):
            replies += f"\x1b]4;{match.group(1).decode()};rgb:0000/0000/0000\x1b\\".encode("ascii")
        # XTGETTCAP (Ms)
        if b"\x1bP+q4d73\x1b\\" in data:
            replies += b"\x1bP1+r4d73=787465726d\x1b\\"
        if b"\x1b]1337;Capabilities" in data:
            replies += b"\x1b]1337;Capabilities=0\x07"
        if replies:
            try:
                os.write(master_fd, bytes(replies))
            except OSError:
                pass

    def complete_step():
        pending_steps.pop(0)

    step_started_at = None
    wait_until = None

    try:
        while True:
            now = time.monotonic()
            if now > deadline and not terminating:
                failure = failure or "scenario timeout"
                terminating = True
                try:
                    os.write(master_fd, TERMINATE)
                except OSError:
                    pass
                cleanup_at = now + 0.5

            if not terminating and step_mode:
                if wait_until is not None and now < wait_until:
                    pass
                elif not pending_steps:
                    terminating = True
                    cleanup_at = now + 0.2
                else:
                    wait_until = None
                    if step_started_at is None:
                        step_started_at = now
                    step = pending_steps[0]
                    if "keys" in step:
                        try:
                            os.write(master_fd, step["keys"].encode("utf-8"))
                        except OSError:
                            pass
                        delay_s = step.get("delay", args.settle_ms) / 1000.0
                        complete_step()
                        step_started_at = None
                        wait_until = now + delay_s
                    elif "waitFor" in step:
                        marker = step["waitFor"]
                        if marker in screen.text():
                            results.append({"step": "waitFor", "marker": marker, "ok": True})
                            complete_step()
                            step_started_at = None
                        else:
                            timeout_s = step.get("timeout", args.timeout_ms) / 1000.0
                            if now - step_started_at >= timeout_s:
                                results.append({"step": "waitFor", "marker": marker, "ok": False, "reason": "timeout"})
                                failure = failure or f"waitFor timeout: {marker}"
                                terminating = True
                                cleanup_at = now + 0.2
                    elif "screenshot" in step:
                        # screenshot names the PNG to render the current screen to.
                        filename = step["screenshot"]
                        html_path = os.path.join(os.path.dirname(os.path.abspath(args.capture)), filename + ".html")
                        try:
                            with open(html_path, "w", encoding="utf-8") as html_handle:
                                html_handle.write(screen.to_html())
                            width, height = screen.pixel_size()
                            png_requests.append({"png": filename, "html": html_path, "width": width, "height": height})
                            results.append({"step": "screenshot", "png": filename, "html": html_path, "ok": True})
                        except OSError as error:
                            results.append({"step": "screenshot", "png": filename, "ok": False, "reason": str(error)})
                            failure = failure or f"screenshot render failed: {error}"
                        complete_step()
                        step_started_at = None
                    elif "assert" in step:
                        expected = step["assert"]
                        ok = expected in screen.text()
                        results.append({"step": "assert", "expected": expected, "ok": ok})
                        complete_step()
                        step_started_at = None
                        if not ok:
                            failure = failure or f"assert failed: {expected}"
                            terminating = True
                            cleanup_at = now + 0.2
                    elif "click" in step:
                        label = step["click"]
                        spot = screen.find(label)
                        if spot is None:
                            results.append({"step": "click", "label": label, "ok": False, "reason": "not found"})
                            failure = failure or f"click target not found: {label}"
                            terminating = True
                            cleanup_at = now + 0.2
                        else:
                            row_index, col_index = spot
                            col = col_index + 1
                            row = row_index + 1
                            press = f"\x1b[<0;{col};{row}M".encode("utf-8")
                            release = f"\x1b[<0;{col};{row}m".encode("utf-8")
                            try:
                                os.write(master_fd, press)
                                os.write(master_fd, release)
                            except OSError:
                                pass
                            results.append({"step": "click", "label": label, "col": col, "row": row, "ok": True})
                            delay_s = step.get("delay", args.settle_ms) / 1000.0
                            complete_step()
                            step_started_at = None
                            wait_until = now + delay_s
                    else:
                        complete_step()
                        step_started_at = None

            # Legacy key-script drain (no steps): send keys on their schedule and
            # terminate one settle after the last key.
            if not terminating and not step_mode and pending:
                if next_action_at is None:
                    next_action_at = now
                if now >= next_action_at:
                    key, delay = pending.pop(0)
                    try:
                        os.write(master_fd, key.encode("utf-8"))
                    except OSError:
                        pass
                    next_action_at = now + delay
                    if not pending:
                        terminate_at = next_action_at + settle_s
            if not terminating and not step_mode and terminate_at is not None and now >= terminate_at:
                terminating = True
                cleanup_at = now + 0.5

            if terminating and now >= cleanup_at:
                break

            drain(0.05)

            try:
                done_pid, _ = os.waitpid(child_pid, os.WNOHANG)
                if done_pid:
                    break
            except ChildProcessError:
                break
    except KeyboardInterrupt:
        pass
    finally:
        try:
            inventory = select.select([master_fd], [], [], 0.3)
            while inventory[0]:
                data = os.read(master_fd, 65536)
                if not data:
                    break
                capture.write(data)
                capture.flush()
                inventory = select.select([master_fd], [], [], 0.1)
        except OSError:
            pass
        capture.close()
        try:
            os.kill(child_pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.close(master_fd)
        except OSError:
            pass

    if args.result_file:
        with open(args.result_file, "w", encoding="utf-8") as handle:
            json.dump({"failure": failure, "results": results, "screen": screen.text(), "pngRequests": png_requests}, handle)

    return 1 if failure else 0


if __name__ == "__main__":
    sys.exit(main())
