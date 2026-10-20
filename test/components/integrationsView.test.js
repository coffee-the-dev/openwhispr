const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");

const { createElement } = React;
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { findElement, installInteractiveDom } = require("../lib/interactiveDom");

const MOCKS = {
  "react-i18next": `
    const t = (key) => key;
    export const useTranslation = () => ({ t, i18n: { language: "en" } });
  `,
  "/stores/settingsStore": `
    export function useSettingsStore(selector) {
      return selector({
        appleCalendarConnected: globalThis.__appleCalendarConnected ?? false,
      });
    }
  `,
  "/integrations/CalendarsPane": `
    import React from "react";
    export function CalendarsPane() { return React.createElement("div", null, "CALENDARS PANE"); }
  `,
  "/ui/select": `
    import React from "react";
    const Pass = ({ children }) => React.createElement("div", null, children);
    export const Select = Pass;
    export const SelectContent = Pass;
    export const SelectTrigger = Pass;
    export const SelectValue = () => null;
    export const SelectItem = ({ children }) => React.createElement("span", null, children);
  `,
  "/ui/button": `
    import React from "react";
    export function Button(props) { return React.createElement("button", props); }
  `,
  "/ui/useToast": `
    export const useToast = () => ({ toast() {} });
  `,
};

function click(element) {
  element.dispatchEvent({
    type: "click",
    bubbles: true,
    button: 0,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
    },
  });
}

const nav = (container) => findElement(container, (node) => node.tagName === "NAV");
const navButton = (container, section) =>
  findElement(
    nav(container),
    (node) =>
      node.tagName === "BUTTON" &&
      node.textContent.trim().startsWith(`integrations.nav.sections.${section}`)
  );
// Icons render whitespace text nodes, so labels are compared trimmed.
const label = (node) => node.textContent.trim();
// Sections stay mounted once opened; only the open one is shown.
const shownText = (node) => {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType === 1 && node.getAttribute("hidden") !== null) return "";
  return node.childNodes.map(shownText).join("");
};
const heading = (container, text) =>
  findElement(container, (node) => node.tagName === "H2" && label(node) === text);
const buttonWithText = (container, text) =>
  findElement(container, (node) => node.tagName === "BUTTON" && label(node) === text);

async function renderView(
  t,
  { section = "calendars", platform = "darwin", appleCalendarConnected = false } = {}
) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const openedUrls = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPlatform: () => platform,
        openExternal(url) {
          openedUrls.push(url);
        },
      },
    },
  });
  globalThis.__appleCalendarConnected = appleCalendarConnected;
  t.after(() => {
    delete globalThis.__appleCalendarConnected;
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-integrations-view-test-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  const { default: IntegrationsView } = await vite.ssrLoadModule(
    "/components/IntegrationsView.tsx"
  );
  function Harness() {
    const [current, setCurrent] = React.useState(section);
    return createElement(IntegrationsView, {
      section: current,
      onSectionChange: setCurrent,
    });
  }
  root = createRoot(container);
  await React.act(async () => root.render(createElement(Harness)));
  return { container, openedUrls };
}

test("sectionMeta counts connected calendars", async (t) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-integrations-sections-test-",
  });
  const { sectionMeta } = await vite.ssrLoadModule(
    "/components/integrations/integrationsSections.ts"
  );

  assert.deepEqual(sectionMeta("calendars", { connectedCalendars: 1 }), {
    kind: "count",
    value: 1,
  });
  assert.equal(sectionMeta("calendars", { connectedCalendars: 0 }), null);
  assert.equal(sectionMeta("cli", { connectedCalendars: 1 }), null);
});

test("the nav lists every section and switches the pane it shows", async (t) => {
  const { container } = await renderView(t);

  const order = [];
  findElement(nav(container), (node) => {
    if (node.tagName === "BUTTON" && label(node).startsWith("integrations.nav.sections.")) {
      order.push(label(node).replace(/^integrations\.nav\.sections\.([a-z]+).*$/, "$1"));
    }
    return false;
  });
  assert.deepEqual(order, ["calendars", "cli"]);
  assert.equal(navButton(container, "calendars").getAttribute("aria-current"), "page");
  assert.match(shownText(container), /CALENDARS PANE/);

  await React.act(async () => click(navButton(container, "cli")));

  assert.equal(navButton(container, "cli").getAttribute("aria-current"), "page");
  assert.equal(navButton(container, "calendars").getAttribute("aria-current"), null);
  assert.doesNotMatch(shownText(container), /CALENDARS PANE/);
  assert.match(shownText(container), /npm install -g @openwhispr\/cli/);
});

test("Calendars stays mounted from any section, so its listeners keep the nav count fresh", async (t) => {
  const { container } = await renderView(t, { section: "cli" });

  assert.match(container.textContent, /CALENDARS PANE/);
  assert.doesNotMatch(shownText(container), /CALENDARS PANE/);
});

test("without Apple Calendar there is no Calendars section", async (t) => {
  const { container } = await renderView(t, { platform: "linux" });

  assert.equal(navButton(container, "calendars"), null);
  assert.equal(navButton(container, "cli").getAttribute("aria-current"), "page");
  assert.doesNotMatch(container.textContent, /CALENDARS PANE/);
});

test("picking a section from the nav leaves focus on the nav", async (t) => {
  const { container } = await renderView(t);
  const cliButton = navButton(container, "cli");
  cliButton.focus();

  await React.act(async () => click(cliButton));

  // Compared as a boolean: a failed assert would try to print the DOM.
  assert.equal(container.ownerDocument.activeElement === cliButton, true);
});

test("a connected Apple Calendar is counted in the nav", async (t) => {
  const { container } = await renderView(t, { appleCalendarConnected: true });

  assert.equal(label(navButton(container, "calendars")), "integrations.nav.sections.calendars1");
  assert.equal(label(navButton(container, "cli")), "integrations.nav.sections.cli");
});

test("the CLI pane opens its documentation", async (t) => {
  const { container, openedUrls } = await renderView(t, { section: "cli" });
  const pane = heading(container, "integrations.nav.sections.cli").parentNode.parentNode;
  await React.act(async () => click(buttonWithText(pane, "integrations.readDocs")));
  assert.equal(openedUrls.at(-1), "https://docs.openwhispr.com/cli/install");
  assert.doesNotMatch(shownText(container), /auth login|integrations\.plan/);
});
