const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The harness renders i18n keys verbatim (no i18next instance is initialized), so
// assertions match on the raw translation key rather than resolved copy. The dropdown
// primitives are stubbed so the menu's items render inline instead of into a portal.
async function renderMenu(t, { withAssistant = true } = {}) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-new-note-menu-test-",
    mockModules: {
      "/ui/dropdown-menu": `
        import { createElement } from "react";
        const passthrough = (props) => createElement("div", null, props.children);
        export const DropdownMenu = passthrough;
        export const DropdownMenuTrigger = passthrough;
        export const DropdownMenuContent = passthrough;
        export const DropdownMenuItem = passthrough;
        export const DropdownMenuSeparator = () => createElement("div", null);
      `,
    },
  });
  const mod = await vite.ssrLoadModule("/components/notes/NewNoteMenu.tsx");
  return renderToStaticMarkup(
    createElement(mod.default, {
      onNewNote: () => {},
      ...(withAssistant ? { onNewChat: () => {} } : {}),
    })
  );
}

test("the New note menu always offers a note and an assistant chat", async (t) => {
  const markup = await renderMenu(t);

  assert.match(markup, /notes\.list\.newNote/);
  assert.match(markup, /notes\.createMenu\.note/);
  assert.match(markup, /notes\.createMenu\.assistantChat/);
});

// The Chat tab disappears entirely when an org turns the assistant off, so the
// item that navigates there goes with it.
test("the New note menu hides the assistant chat when the assistant is off", async (t) => {
  const markup = await renderMenu(t, { withAssistant: false });

  assert.doesNotMatch(markup, /notes\.createMenu\.assistantChat/);
  assert.match(markup, /notes\.createMenu\.note/);
});
