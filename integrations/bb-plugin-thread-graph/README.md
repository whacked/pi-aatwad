# bb-plugin-thread-graph (proof of concept)

A sidebar graph of bb threads and their parent/child links, drawn above bb's own thread list.
It is the first step towards showing pi-recursive-team members as bb threads: a member spawned
under its leader's thread appears to the leader's right.


## What it does

- Registers a **list** sidebar navigation (`experimental_sidebarNavigation`, placement
  `list`). It renders bb's own Top list rows (New thread, Plugins, Skills, …) first, then the
  graph. bb's thread list below is unchanged.
- Lays threads out **left to right** with [dagre](https://github.com/dagrejs/dagre): a
  thread's children (`parentThreadId`) sit in the next column.
- Threads with **no parent and no children** float in a strip below the trees, newest first,
  with a dashed outline. A thread whose parent is not shown (archived, hidden or in another
  project) is marked ↰.
- Each node shows bb's status glyph and title; the open thread is highlighted and scrolled into
  view. Click opens the thread, ⌘/Ctrl-click opens it in a split.
- Drag or scroll to pan, pinch or ctrl/⌘-scroll to zoom, **fit** shows the whole graph,
  **project/all** switches between the current project and every project, the title collapses
  the panel and the bottom edge resizes it. These choices are remembered per browser.

## Requirements

bb **0.47 or later** (plugin SDK 0.6.157+). bb 0.46.x removed the sidebar navigation slot, so
the plugin installs there but stays "incompatible" and is not loaded.

## Install

```sh
cd integrations/bb-plugin-thread-graph
npm install
bb plugin install .
```

bb's navigation setting defaults to "automatic", which picks the first plugin navigation, so
the graph appears straight away. Otherwise choose **Top list + thread graph** in
Settings → Appearance → Navigation (or `bb settings ui set sidebar.navigationProvider
thread-graph/thread-graph`). Because it draws bb's **Top list** rows, a user of the left **Rail**
layout sees the Top list instead while it is selected. Remove with `bb plugin uninstall
thread-graph`.

After editing: `bb plugin build && bb plugin reload thread-graph` (or `bb plugin dev`).

## Develop

- `layout.ts` — pure layout (dagre + floating strip), tested by `npm test`.
- `ThreadGraph.tsx` — the sidebar component (HTML nodes over an SVG edge layer, so nodes can
  use bb's own status glyph).
- `app.tsx` — slot registration. `server.ts` — empty backend (bb requires one).
- `npm run typecheck` checks against the pinned SDK.

## Known limits

- Uses experimental bb APIs (`experimental_sidebarNavigation`, `experimental_useSidebarThreads`,
  and the deprecated `experimental_Original` for bb's Top list rows); a bb update may break it.
- Only active threads are drawn. Large thread counts are drawn in full (no windowing yet).
- Links between pi-recursive-team teams (join/lead) are not shown yet; only bb's own parent
  links.
