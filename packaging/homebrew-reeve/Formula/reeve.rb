# frozen_string_literal: true

# Homebrew formula for Reeve, published to npm as `reeve-board`
# (`reeve` was already taken). Follows homebrew-core's own Node pattern —
# `depends_on "node"`, `std_npm_args`, `bin.install_symlink` — so it can move
# there unchanged once Reeve has the install base homebrew-core asks for.
#
# `bin/bump-formula.sh` in this tap's root rewrites `url` and `sha256` below
# for a new release; see that script and `.github/workflows/bump.yml`.
class Reeve < Formula
  desc "Local kanban board that runs Claude Agent SDK stages in git worktrees"
  homepage "https://github.com/ryanbrunner/reeve"
  url "https://registry.npmjs.org/reeve-board/-/reeve-board-0.1.0.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on "node"

  # Denied by default; the fuller test below starts a real server on
  # 127.0.0.1 and polls it, which needs loopback TCP.
  allow_network_access! :test

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      Reeve needs a Claude login — the one Claude Code uses — or an
      ANTHROPIC_API_KEY in the environment before a stage can run.

      Two more things are optional: `gh`, logged in, to push a Done card's
      branch and open its pull request, and a Chromium for Testing's
      screenshots, which Homebrew does not install —
        npx playwright install chromium

      The board, its database and its images live in ~/.reeve, independent
      of this formula's Cellar directory, so an upgrade keeps your board.

      Run `reeve doctor` after installing: it checks the native SQLite
      binding and whether a Chromium is there for screenshots.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/reeve --version")

    # Nothing is listening on a freshly chosen port, so this is the "down"
    # case `reeve status` exists to answer without it looking like a failure.
    port = free_port
    down_url = "http://127.0.0.1:#{port}"
    output = shell_output("#{bin}/reeve status --url #{down_url} 2>&1", 1)
    assert_match "isn't running", output

    # The fuller check: start a real server on a scratch board and poll
    # status until it answers, rather than trusting a fixed sleep. `spawn`
    # rather than `fork` + `exec`: forking the whole sandboxed test process
    # leaves it holding the PTY brew's test runner wraps it in, and the
    # parent's next `system` call never returns.
    pid = Process.spawn(bin/"reeve", "serve", "--no-open", "--port", port.to_s,
                        "--db", (testpath/"reeve.db").to_s,
                        "--assets", (testpath/"assets").to_s,
                        out: File::NULL, err: File::NULL)

    begin
      answered = false
      20.times do
        answered = system bin/"reeve", "status", "--url", down_url
        break if answered

        sleep 0.5
      end
      assert answered, "reeve serve never answered on #{down_url}"
    ensure
      Process.kill("TERM", pid)
      Process.wait(pid)
    end
  end
end
