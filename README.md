# ComfyUI-NodeRenamer

Frontend-only batch rename utility for ComfyUI nodes.

## Features

- Rename selected nodes as `BaseName + incrementing index`
- Selectable sort order for sequential rename
  - `Selection Order` - rename in the order nodes were selected
  - `Position (Top-Left -> Right -> Down)` - sort nodes from the top-left, moving right across each row, then downward
  - `Current Node Name` - sort by the current visible node title using natural sorting (for example, `Node_2` comes before `Node_10`)
- Numeric `Padding`
  - Padding `0` -> `1, 2, 3...`
  - Padding `2` -> `001, 002, 003...`
  - Padding `5` -> `000001, 000002, 000003...`

  ![alt text](TutorialMoves/movie01.gif)
- Prefix / Suffix
  ![alt text](TutorialMoves/movie02.gif)

- Find / Replace, optionally case-sensitive
  ![alt text](TutorialMoves/movie03.gif)

- Case conversion
  - `snake_case`
  - `camelCase`
  - `PascalCase`
  ![alt text](TutorialMoves/movie04.gif)

- Preview before applying
- Undo last rename (up to 20 operations in the current browser session)

## Install

Copy this folder into:

`ComfyUI/custom_nodes/ComfyUI-NodeRenamer`

Then restart ComfyUI and reload the browser page.

## Usage

1. Select the nodes to rename.
2. Open **Node Renamer** from the selection toolbox or top menu.
3. For **Sequential Rename**, choose the desired **Sort Order**.
4. Choose the operation and preview the result.
5. Click **Apply**.

## Notes

This extension changes only the visible node title (`node.title`). It does not alter node type, inputs, outputs, widgets, or backend execution behavior.

`Selection Order` is tracked when nodes transition into the selected state. If another extension creates a multi-selection without emitting normal node selection callbacks, Node Renamer falls back to ComfyUI's current selected-node enumeration for those nodes.

`Position (Top-Left -> Right -> Down)` is intended for box-selected or spatially arranged nodes. Nodes are grouped into rows with a small vertical tolerance, then sorted left-to-right within each row.

`Current Node Name` uses natural sorting so numeric suffixes are ordered as expected, such as `Node_1`, `Node_2`, `Node_10`.
