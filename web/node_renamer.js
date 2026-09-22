import { app } from "/scripts/app.js";

const EXTENSION_NAME = "HOS.NodeRenamer";
const COMMAND_ID = "hos.nodeRenamer.open";
const VERSION = "0.1.1";
const POSITION_ROW_TOLERANCE = 32;
const naturalNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const selectionOrder = [];
const trackedNodes = new WeakSet();
const undoStack = [];
let modal = null;
let activeMode = "sequential";

function nodeKey(node) {
  return String(node?.id ?? node?._id ?? "");
}

function currentTitle(node) {
  const title = node?.title;
  if (typeof title === "string" && title.length > 0) return title;
  return String(node?.type ?? node?.comfyClass ?? `Node_${nodeKey(node)}`);
}

function addSelection(node) {
  const key = nodeKey(node);
  if (!key) return;
  const idx = selectionOrder.findIndex((entry) => entry.key === key);
  if (idx !== -1) selectionOrder.splice(idx, 1);
  selectionOrder.push({ key, node });
}

function removeSelection(node) {
  const key = nodeKey(node);
  const idx = selectionOrder.findIndex((entry) => entry.key === key);
  if (idx !== -1) selectionOrder.splice(idx, 1);
}

function trackNode(node) {
  if (!node || trackedNodes.has(node)) return;
  trackedNodes.add(node);

  const originalSelected = node.onSelected;
  const originalDeselected = node.onDeselected;

  node.onSelected = function (...args) {
    addSelection(this);
    return originalSelected?.apply(this, args);
  };

  node.onDeselected = function (...args) {
    removeSelection(this);
    return originalDeselected?.apply(this, args);
  };
}

function selectedNodeMap() {
  const selected = app.canvas?.selected_nodes ?? app.canvas?.selectedNodes ?? {};
  if (selected instanceof Map) return new Map(selected);
  if (Array.isArray(selected)) return new Map(selected.map((n) => [nodeKey(n), n]));
  return new Map(Object.entries(selected).map(([k, v]) => [String(k), v]));
}

function getSelectedNodesInOrder() {
  const selected = selectedNodeMap();
  const result = [];
  const seen = new Set();

  // Preserve explicit click-selection history first.
  for (const entry of selectionOrder) {
    const node = selected.get(entry.key) ?? entry.node;
    if (node && selected.has(entry.key) && !seen.has(entry.key)) {
      result.push(node);
      seen.add(entry.key);
    }
  }

  // Fallback for selections created by box-select / load / other extensions.
  for (const [key, node] of selected) {
    if (node && !seen.has(String(key))) {
      result.push(node);
      seen.add(String(key));
    }
  }

  return result;
}

function nodePosition(node) {
  const pos = node?.pos;
  if (Array.isArray(pos) || ArrayBuffer.isView(pos)) {
    return {
      x: Number(pos[0]) || 0,
      y: Number(pos[1]) || 0,
    };
  }
  return { x: 0, y: 0 };
}

function sortNodesByPosition(nodes) {
  const pending = [...nodes].sort((a, b) => {
    const pa = nodePosition(a);
    const pb = nodePosition(b);
    return (pa.y - pb.y) || (pa.x - pb.x) || nodeKey(a).localeCompare(nodeKey(b));
  });

  const rows = [];
  for (const node of pending) {
    const { y } = nodePosition(node);
    const currentRow = rows.at(-1);
    if (!currentRow || Math.abs(y - currentRow.anchorY) > POSITION_ROW_TOLERANCE) {
      rows.push({ anchorY: y, nodes: [node] });
    } else {
      currentRow.nodes.push(node);
    }
  }

  return rows.flatMap((row) =>
    row.nodes.sort((a, b) => {
      const pa = nodePosition(a);
      const pb = nodePosition(b);
      return (pa.x - pb.x) || (pa.y - pb.y) || nodeKey(a).localeCompare(nodeKey(b));
    }),
  );
}

function sortNodesByCurrentName(nodes) {
  return [...nodes].sort((a, b) => {
    const byName = naturalNameCollator.compare(currentTitle(a), currentTitle(b));
    if (byName !== 0) return byName;
    const pa = nodePosition(a);
    const pb = nodePosition(b);
    return (pa.y - pb.y) || (pa.x - pb.x) || nodeKey(a).localeCompare(nodeKey(b));
  });
}

function getSelectedNodesForOperation() {
  const nodes = getSelectedNodesInOrder();
  if (activeMode !== "sequential") return nodes;

  const sortMode = getControl("sort-order")?.value ?? "selection";
  if (sortMode === "position") return sortNodesByPosition(nodes);
  if (sortMode === "name") return sortNodesByCurrentName(nodes);
  return nodes;
}

function tokenizeName(value) {
  return String(value ?? "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function capitalize(word) {
  return word ? word[0].toUpperCase() + word.slice(1) : "";
}

function convertCase(value, mode) {
  const words = tokenizeName(value);
  if (words.length === 0) return "";
  if (mode === "snake") return words.join("_");
  if (mode === "camel") return words[0] + words.slice(1).map(capitalize).join("");
  return words.map(capitalize).join("");
}

function paddedIndex(index, padding) {
  const n = String(index);
  const width = Math.max(1, Number(padding) + 1);
  return n.padStart(width, "0");
}

function getControl(id) {
  return modal?.querySelector(`#nnt-${id}`);
}

function computeNames(nodes) {
  if (activeMode === "sequential") {
    const base = getControl("base")?.value ?? "";
    const start = Number.parseInt(getControl("start")?.value ?? "1", 10) || 0;
    const padding = Math.max(0, Number.parseInt(getControl("padding")?.value ?? "0", 10) || 0);
    return nodes.map((_, i) => `${base}${paddedIndex(start + i, padding)}`);
  }

  if (activeMode === "affix") {
    const prefix = getControl("prefix")?.value ?? "";
    const suffix = getControl("suffix")?.value ?? "";
    return nodes.map((node) => `${prefix}${currentTitle(node)}${suffix}`);
  }

  if (activeMode === "replace") {
    const find = getControl("find")?.value ?? "";
    const replace = getControl("replace")?.value ?? "";
    const caseSensitive = Boolean(getControl("case-sensitive")?.checked);
    if (!find) return nodes.map(currentTitle);

    if (caseSensitive) {
      return nodes.map((node) => currentTitle(node).split(find).join(replace));
    }

    const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "gi");
    return nodes.map((node) => currentTitle(node).replace(regex, replace));
  }

  const caseMode = getControl("case-mode")?.value ?? "snake";
  return nodes.map((node) => convertCase(currentTitle(node), caseMode));
}

function markDirty() {
  app.canvas?.setDirty?.(true, true);
  app.canvas?.graph?.setDirtyCanvas?.(true, true);
}

function withGraphChange(fn) {
  const canvas = app.canvas;
  const graph = canvas?.graph;
  try {
    canvas?.emitBeforeChange?.();
    graph?.beforeChange?.();
    fn();
  } finally {
    graph?.afterChange?.();
    canvas?.emitAfterChange?.();
    markDirty();
  }
}

function applyRename() {
  const nodes = getSelectedNodesForOperation();
  if (!nodes.length) {
    showStatus("No nodes are selected.", true);
    return;
  }

  const names = computeNames(nodes);
  const snapshot = nodes.map((node) => ({
    node,
    hadOwnTitle: Object.prototype.hasOwnProperty.call(node, "title"),
    title: node.title,
  }));

  withGraphChange(() => {
    nodes.forEach((node, i) => {
      node.title = names[i];
    });
  });

  undoStack.push(snapshot);
  if (undoStack.length > 20) undoStack.shift();
  showStatus(`Renamed ${nodes.length} node(s).`);
  refreshPreview();
}

function undoLastRename() {
  const snapshot = undoStack.pop();
  if (!snapshot) {
    showStatus("Nothing to undo.", true);
    return;
  }

  withGraphChange(() => {
    for (const entry of snapshot) {
      if (entry.hadOwnTitle) entry.node.title = entry.title;
      else delete entry.node.title;
    }
  });

  showStatus(`Restored ${snapshot.length} node name(s).`);
  refreshPreview();
}

function showStatus(message, error = false) {
  const el = getControl("status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("nnt-error", error);
}

function refreshPreview() {
  if (!modal) return;
  const nodes = getSelectedNodesForOperation();
  const preview = getControl("preview");
  const count = getControl("count");
  if (!preview || !count) return;

  count.textContent = `${nodes.length} selected`;
  preview.innerHTML = "";

  if (!nodes.length) {
    preview.innerHTML = '<div class="nnt-empty">Select one or more nodes.</div>';
    return;
  }

  const names = computeNames(nodes);
  nodes.forEach((node, i) => {
    const row = document.createElement("div");
    row.className = "nnt-preview-row";
    row.innerHTML = `
      <span class="nnt-order">${i + 1}</span>
      <span class="nnt-old"></span>
      <span class="nnt-arrow">→</span>
      <span class="nnt-new"></span>
    `;
    row.querySelector(".nnt-old").textContent = currentTitle(node);
    row.querySelector(".nnt-new").textContent = names[i];
    preview.appendChild(row);
  });
}

function setMode(mode) {
  activeMode = mode;
  for (const btn of modal.querySelectorAll(".nnt-tab")) {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  }
  for (const panel of modal.querySelectorAll(".nnt-panel")) {
    panel.classList.toggle("active", panel.dataset.mode === mode);
  }
  refreshPreview();
}

function closeModal() {
  modal?.remove();
  modal = null;
}

function createModal() {
  closeModal();

  modal = document.createElement("div");
  modal.className = "nnt-overlay";
  modal.innerHTML = `
    <style>
      .nnt-overlay{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.48);display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif}
      .nnt-dialog{width:min(900px,92vw);max-height:86vh;background:#202124;color:#eee;border:1px solid #4b4d52;border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden}
      .nnt-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #3d3f43}.nnt-title{font-size:17px;font-weight:650}.nnt-close{background:none;border:0;color:#bbb;font-size:24px;cursor:pointer}
      .nnt-body{display:grid;grid-template-columns:minmax(310px,.9fr) minmax(340px,1.1fr);min-height:420px;overflow:auto}.nnt-left{padding:16px;border-right:1px solid #3d3f43}.nnt-right{padding:16px;min-width:0}
      .nnt-tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:14px}.nnt-tab{border:1px solid #4b4d52;background:#2a2c30;color:#ddd;padding:8px;border-radius:7px;cursor:pointer}.nnt-tab.active{background:#3a465d;border-color:#6682b6;color:white}
      .nnt-panel{display:none}.nnt-panel.active{display:block}.nnt-field{display:grid;gap:6px;margin:12px 0}.nnt-field label{font-size:12px;color:#b9bbc1}.nnt-field input,.nnt-field select{width:100%;box-sizing:border-box;border:1px solid #51545a;background:#17181a;color:#f2f2f2;border-radius:6px;padding:8px 9px}.nnt-inline{display:flex;align-items:center;gap:8px;font-size:13px;color:#ddd}
      .nnt-help{font-size:12px;line-height:1.45;color:#9fa3ab;margin-top:5px}.nnt-preview-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.nnt-preview-title{font-weight:650}.nnt-count{font-size:12px;color:#aaa}.nnt-preview{display:grid;gap:5px;max-height:370px;overflow:auto}.nnt-preview-row{display:grid;grid-template-columns:34px minmax(0,1fr) 22px minmax(0,1fr);align-items:center;gap:5px;background:#17181a;border:1px solid #34363a;border-radius:6px;padding:7px 8px;font-size:12px}.nnt-order{color:#8ea9d6}.nnt-old,.nnt-new{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nnt-old{color:#aaa}.nnt-new{color:#f2f2f2}.nnt-arrow{text-align:center;color:#777}.nnt-empty{padding:24px;text-align:center;color:#888;border:1px dashed #444;border-radius:7px}
      .nnt-foot{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid #3d3f43}.nnt-status{margin-right:auto;font-size:12px;color:#9fcca6}.nnt-status.nnt-error{color:#ef9a9a}.nnt-btn{border:1px solid #555;background:#2b2d31;color:#eee;border-radius:7px;padding:8px 13px;cursor:pointer}.nnt-btn.primary{background:#45628e;border-color:#6484b7}.nnt-btn:hover{filter:brightness(1.1)}
      @media(max-width:760px){.nnt-body{grid-template-columns:1fr}.nnt-left{border-right:0;border-bottom:1px solid #3d3f43}}
    </style>
    <div class="nnt-dialog" role="dialog" aria-modal="true" aria-label="Node Renamer">
      <div class="nnt-head"><div class="nnt-title">Node Renamer <span style="font-size:11px;color:#8f949c;font-weight:500">v${VERSION}</span></div><button class="nnt-close" title="Close">×</button></div>
      <div class="nnt-body">
        <div class="nnt-left">
          <div class="nnt-tabs">
            <button class="nnt-tab active" data-mode="sequential">Sequential</button>
            <button class="nnt-tab" data-mode="affix">Prefix / Suffix</button>
            <button class="nnt-tab" data-mode="replace">Replace</button>
            <button class="nnt-tab" data-mode="case">Case</button>
          </div>

          <div class="nnt-panel active" data-mode="sequential">
            <div class="nnt-field"><label>Base Name</label><input id="nnt-base" value="Node_" /></div>
            <div class="nnt-field"><label>Start Index</label><input id="nnt-start" type="number" step="1" value="1" /></div>
            <div class="nnt-field"><label>Padding</label><input id="nnt-padding" type="number" min="0" step="1" value="2" /></div>
            <div class="nnt-help">Padding means the number of leading-zero positions. Example: Padding 2 → 001, 002, 256. Padding 5 → 000001, 000002, 000256.</div>
            <div class="nnt-field"><label>Sort Order</label>
              <select id="nnt-sort-order">
                <option value="position" selected>Position (Top-Left → Right → Down)</option>
                <option value="name">Current Node Name</option>
                <option value="selection">Selection Order</option>
              </select>
            </div>
            <div class="nnt-help">Position groups nearby Y positions into the same row, then sorts each row from left to right. Name uses natural numeric order (for example: Node_2 before Node_10).</div>
          </div>

          <div class="nnt-panel" data-mode="affix">
            <div class="nnt-field"><label>Prefix</label><input id="nnt-prefix" placeholder="prefix_" /></div>
            <div class="nnt-field"><label>Suffix</label><input id="nnt-suffix" placeholder="_suffix" /></div>
          </div>

          <div class="nnt-panel" data-mode="replace">
            <div class="nnt-field"><label>Find</label><input id="nnt-find" /></div>
            <div class="nnt-field"><label>Replace With</label><input id="nnt-replace" /></div>
            <label class="nnt-inline"><input id="nnt-case-sensitive" type="checkbox" /> Case Sensitive</label>
          </div>

          <div class="nnt-panel" data-mode="case">
            <div class="nnt-field"><label>Case</label>
              <select id="nnt-case-mode">
                <option value="snake">snake_case</option>
                <option value="camel">camelCase</option>
                <option value="pascal">PascalCase</option>
              </select>
            </div>
            <div class="nnt-help">Separators, spaces, snake_case, kebab-case and existing camel/Pascal boundaries are normalized before conversion.</div>
          </div>
        </div>

        <div class="nnt-right">
          <div class="nnt-preview-head"><div class="nnt-preview-title">Preview</div><div id="nnt-count" class="nnt-count"></div></div>
          <div id="nnt-preview" class="nnt-preview"></div>
        </div>
      </div>
      <div class="nnt-foot">
        <div id="nnt-status" class="nnt-status"></div>
        <button id="nnt-undo" class="nnt-btn">Undo Last Rename</button>
        <button id="nnt-apply" class="nnt-btn primary">Apply</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector(".nnt-close").addEventListener("click", closeModal);
  modal.addEventListener("mousedown", (event) => {
    if (event.target === modal) closeModal();
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
  });

  for (const btn of modal.querySelectorAll(".nnt-tab")) {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  }

  for (const input of modal.querySelectorAll("input, select")) {
    input.addEventListener("input", refreshPreview);
    input.addEventListener("change", refreshPreview);
  }

  getControl("apply").addEventListener("click", applyRename);
  getControl("undo").addEventListener("click", undoLastRename);

  refreshPreview();
  getControl("base")?.focus();
}

function openTool() {
  createModal();
}

app.registerExtension({
  name: EXTENSION_NAME,

  nodeCreated(node) {
    trackNode(node);
  },

  loadedGraphNode(node) {
    trackNode(node);
  },

  commands: [
    {
      id: COMMAND_ID,
      label: "Node Renamer",
      icon: "pi pi-pencil",
      function: openTool,
    },
  ],

  menuCommands: [
    {
      path: ["Node Renamer"],
      commands: [COMMAND_ID],
    },
  ],

  getSelectionToolboxCommands(selectedItem) {
    if (!selectedItem) return [];
    return [COMMAND_ID];
  },
});
