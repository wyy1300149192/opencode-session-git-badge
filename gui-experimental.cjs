// Uncommitted-change dot for the OpenCode Desktop session list.
//
// The desktop session list has no plugin slot, so this follows the markup of the
// 2.3 vertical tab sidebar: each row is [data-slot="titlebar-tab-item"], its link
// carries the session URL, and the title is [data-slot="tab-title"].
//
// A row whose repository has uncommitted files gets a small warning-colored dot
// at the start of the row, before the project icon. Clean repositories and
// non-repositories get nothing.
//
// This is intentionally dependency-free: the host provides @opencode/plugin/gui
// at runtime, and the entry only touches the DOM plus the local server API.

const { Plugin, Style } = require("@opencode/plugin/gui")

const ROW = '[data-slot="titlebar-tab-item"]'
const LINK = '[data-slot="tab-link"]'
const TITLE = '[data-slot="tab-title"]'
const PROJECT = '[data-slot="tab-project"], [data-slot="tab-label"]'

const BADGE = "data-session-git"

const CACHE_MS = 4000
const FAIL_MS = 15000
const SESSIONS_MS = 20000
const REQUEST_MS = 10000

const CSS = `
[${BADGE}] {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  margin-inline-end: 1px;
  background: var(--color-v2-state-fg-warning, #d97706);
}
`

module.exports = Plugin.define({
  setup(ctx) {
    ctx.add(Style, CSS)

    let stopped = false
    let observer
    let timer
    let tick
    let loading = false
    let sessions = new Map()
    let titles = new Map()
    let byId = new Map()
    let sessionsAt = 0
    let lastPass = 0

    // directory -> { count, at, pending, failed }
    const repos = new Map()

    const named = (project) => project.name || project.canonical.split("/").pop()

    async function loadSessions() {
      if (loading) return
      loading = true
      try {
        const [page, projects] = await Promise.all([
          ctx.client.session.list({ parentID: null, limit: 200, order: "desc" }),
          ctx.client.project.list(),
        ])
        const names = new Map(projects.map((project) => [project.id, named(project)]))
        const found = new Map()
        const ambiguous = new Set()
        const byTitle = new Map()
        const ids = new Map()

        for (const session of page.data ?? []) {
          const project = names.get(session.projectID)
          const title = session.title
          const directory = session.location?.directory

          if (!project || !title || !directory) continue
          ids.set(session.id, directory)
          const key = `${project}\n${title}`
          const previous = found.get(key)

          if (previous && previous !== directory) ambiguous.add(key)
          found.set(key, directory)

          const seen = byTitle.get(title) ?? new Set()
          seen.add(directory)
          byTitle.set(title, seen)
        }

        for (const key of ambiguous) found.delete(key)

        const unique = new Map()

        for (const [title, directories] of byTitle) {
          if (directories.size === 1) unique.set(title, [...directories][0])
        }

        sessions = found
        titles = unique
        byId = ids
        sessionsAt = Date.now()
      } catch {
        // Keep the previous map; the next pass retries.
      } finally {
        loading = false
      }
    }

    async function loadRepo(directory) {
      const now = Date.now()
      const previous = repos.get(directory)

      // A request that is still running owns the entry. Never reset its timer:
      // overlapping requests can finish out of order and put an old count back.
      if (previous?.pending) return
      if (previous && now - previous.at < (previous.failed ? FAIL_MS : CACHE_MS)) return

      const entry = {
        count: previous?.count,
        at: now,
        pending: true,
        failed: false,
      }
      repos.set(directory, entry)

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_MS)

      try {
        const status = await ctx.client.vcs.status(
          { location: { directory } },
          { signal: controller.signal },
        )

        if (repos.get(directory) !== entry) return
        entry.count = Array.isArray(status?.data) ? status.data.length : 0
      } catch {
        if (repos.get(directory) !== entry) return
        entry.failed = true
      } finally {
        clearTimeout(timeout)

        if (repos.get(directory) === entry) {
          entry.pending = false
          entry.at = Date.now()
          schedule()
        }
      }
    }

    function directoryOf(row) {
      const href = row.querySelector(LINK)?.getAttribute("href") ?? ""
      const match = href.match(/\/session\/([^/?#]+)/)

      if (match) {
        const directory = byId.get(decodeURIComponent(match[1]))

        if (directory) return directory
      }

      const title = row.querySelector(TITLE)?.textContent?.trim()
      const project = row.querySelector(PROJECT)?.textContent?.trim()

      if (!title) return
      if (!project) return titles.get(title)
      return sessions.get(`${project}\n${title}`) ?? titles.get(title)
    }

    function badgeOf(row) {
      let badge = row.querySelector(`[${BADGE}]`)

      if (badge) return badge
      const link = row.querySelector(LINK)

      if (!link) return
      badge = document.createElement("span")
      badge.setAttribute(BADGE, "")
      link.prepend(badge)

      return badge
    }

    function render(badge, entry) {
      const count = entry.count ?? 0

      if (count === 0) {
        badge.remove()
        return
      }

      const title = `${count} 个未提交文件`

      if (badge.title !== title) badge.title = title
    }

    function remove(badge) {
      if (badge) badge.remove()
    }

    function pass() {
      if (stopped) return
      lastPass = Date.now()

      if (lastPass - sessionsAt > SESSIONS_MS) {
        void loadSessions().then(schedule)
      }

      document.querySelectorAll(ROW).forEach((row) => {
        const directory = directoryOf(row)
        const badge = row.querySelector(`[${BADGE}]`)

        if (!directory) {
          remove(badge)
          return
        }

        const entry = repos.get(directory)

        // loadRepo respects the cache and never overlaps a running request.
        void loadRepo(directory)
        if (!entry) return
        if (entry.failed || (entry.count ?? 0) === 0) {
          remove(badge)
          return
        }

        const element = badgeOf(row)

        if (element) render(element, entry)
      })
    }

    function schedule() {
      if (stopped) return
      clearTimeout(timer)
      timer = setTimeout(pass, 150)
    }

    loadSessions().then(schedule)

    observer = new MutationObserver(schedule)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    tick = setInterval(() => {
      void loadSessions().then(schedule)
    }, SESSIONS_MS)

    const refresh = setInterval(() => {
      // Expire only settled entries; a pending request keeps its own timer.
      for (const entry of repos.values()) {
        if (!entry.pending) entry.at = 0
      }
      pass()
    }, CACHE_MS)

    // Make the first pass render as soon as the sidebar exists.
    queueMicrotask(schedule)

    return () => {
      stopped = true
      clearTimeout(timer)
      clearInterval(tick)
      clearInterval(refresh)
      observer?.disconnect()
    }
  },
})

module.exports.default = module.exports
