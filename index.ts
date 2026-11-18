import { Plugin } from "@opencode/plugin"

// The GUI part lives in gui-experimental.cjs. This server part only gives the
// package its id, so the desktop app loads the GUI entry instead of treating the
// GUI bundle as a server plugin. It also anchors the file watcher.
export default Plugin.define({
  id: "opencode-session-git-badge",
  setup() {},
})
