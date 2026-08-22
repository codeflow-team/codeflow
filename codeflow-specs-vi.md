# CodeFlow — Đặc tả Workflow Native cho Code

**Trạng thái:** Draft v0.1  
**Loại:** Library / SDK  
**Ngôn ngữ chính:** TypeScript  
**Nguyên tắc cốt lõi:** **Code là source of truth. Workflow là projection trực quan, có thể chỉnh sửa của code.**

---

## 1. Tổng quan

CodeFlow là một library cho phép chuyển code TypeScript có thể thực thi thành workflow graph dễ hiểu với người dùng, đồng thời cho phép người dùng chỉnh sửa các semantics được hỗ trợ thông qua UI trực quan mà không thay thế hoặc generate lại toàn bộ code gốc.

Use case chính là code do AI tạo:

1. AI viết TypeScript bình thường.
2. CodeFlow phân tích code.
3. Các semantics được hỗ trợ được chuyển thành workflow nodes/edges.
4. End user xem và chỉnh workflow thông qua UI.
5. CodeFlow tạo source patch tối thiểu vào code gốc.
6. Code sau khi chỉnh sửa vẫn là representation chuẩn duy nhất.

### Giá trị cốt lõi

> **Code dành cho AI và developer. Workflow dành cho con người.**

CodeFlow không phải chủ yếu là workflow runtime hay visual programming language. Nó là một **code-to-workflow compiler và bidirectional editing layer**.

---

# 2. Vấn đề

Code-first rất mạnh nhưng khó cho non-developer đọc và chỉnh sửa.

Visual workflow dễ tiếp cận nhưng thường tạo ra một representation thứ hai của logic và buộc người dùng vào một programming model giới hạn bởi các node.

Điều này tạo ra hai vấn đề:

- AI rất giỏi generate code nhưng end user có thể không hiểu code.
- Visual workflow dễ hiểu nhưng khó biểu diễn arbitrary/custom logic.

CodeFlow giải quyết bằng cách giữ executable code làm representation chuẩn và sinh semantic workflow graph từ code.

---

# 3. Mục tiêu

## 3.1 Mục tiêu chính

### G1 — Code → Workflow

Chuyển các semantics được hỗ trợ của TypeScript thành semantic workflow graph.

### G2 — Workflow → Code

Cho phép chỉnh sửa các thuộc tính workflow được hỗ trợ và chuyển các thay đổi thành source-code patch tối thiểu.

### G3 — Bảo toàn source

Không generate lại toàn bộ file khi user chỉ sửa một phần nhỏ.

Ví dụ:

```diff
 await slack.send({
-  channel: "#security"
+  channel: "#security-team"
 });
```

### G4 — Progressive disclosure

Hỗ trợ ba cấp độ người dùng:

- Beginner: visual nodes.
- Power user: node + expression/configuration.
- Developer: full source code.

### G5 — Extensibility

Cho phép function, tool, MCP tool và custom code trở thành workflow node mà không cần sửa core analyzer.

### G6 — Graceful degradation

Code mà CodeFlow không hiểu phải vẫn được giữ nguyên và hiển thị dưới dạng custom/unknown code thay vì đoán sai semantics.

---

# 4. Không nằm trong mục tiêu

Phiên bản đầu không nhằm:

- thực thi workflow;
- thay thế Temporal, Inngest, BullMQ hoặc custom executor;
- hỗ trợ mọi construct của TypeScript dưới dạng visual node;
- tạo một visual programming language mới;
- biến workflow JSON thành source of truth;
- reverse-engineer hoàn hảo mọi loại application code thành workflow;
- execute custom code bên trong core library.

---

# 5. Nguyên tắc thiết kế

## 5.1 Source là canonical

Source code là representation chuẩn duy nhất.

Workflow graph chỉ là projection.

```text
Source Code
    ↓
Parser
    ↓
Semantic Analyzer
    ↓
Workflow Graph
    ↓
UI
```

Chiều ngược lại:

```text
UI Edit
    ↓
Semantic Node
    ↓
Patch Engine
    ↓
Source Code
```

## 5.2 Semantic projection, không phải AST visualization

Workflow không được expose từng AST node.

Ví dụ:

```ts
files
  .filter(x => x.active)
  .map(x => transform(x))
  .sort(compare);
```

có thể được biểu diễn thành một node:

```text
Transform
```

thay vì ba node cấp thấp.

## 5.3 Minimal mutation

Một thay đổi trên workflow chỉ được sửa vùng source cần thiết.

## 5.4 Stable identity

Node identity phải tồn tại qua formatting, thay đổi line và các thay đổi không liên quan.

## 5.5 Thể hiện rõ uncertainty

Nếu CodeFlow không chắc construct có nghĩa gì, phải đánh dấu unknown/custom thay vì tự suy diễn.

## 5.6 Runtime independence

Core không được phụ thuộc vào một workflow execution engine cụ thể.

---

# 6. Kiến trúc tổng thể

```text
                         AI / Developer
                              │
                              ▼
                     ┌─────────────────┐
                     │ TypeScript Code │
                     │ SOURCE OF TRUTH │
                     └────────┬────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │     Parser      │
                     │  Tree-sitter /  │
                     │   TS Parser     │
                     └────────┬────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │ Semantic        │
                     │ Analyzer        │
                     │                 │
                     │ Control Flow    │
                     │ Data Flow       │
                     │ Tool Detection  │
                     │ Node Mapping    │
                     └────────┬────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │ Workflow Graph  │
                     │   Projection    │
                     └───────┬─────────┘
                             │
                  ┌──────────┴──────────┐
                  ▼                     ▼
             Layout Engine          Registry
                ELK.js             Tools/MCP
                  │
                  ▼
             React Flow UI
                  │
        ┌─────────┼─────────┐
        ▼         ▼         ▼
      Node     Inspector   Monaco
      Editor              Code View
        │
        ▼
     Patch Engine
        │
        ▼
    Source Code
```

---

# 7. Cấu trúc package

Project là một TypeScript monorepo.

```text
packages/
├── core/
├── parser/
├── analyzer/
├── mapper/
├── patcher/
├── registry/
├── mcp/
├── layout/
├── ui/
├── code-editor/
└── react/
```

## 7.1 `@codeflow/core`

Domain model độc lập framework.

Chịu trách nhiệm:

- workflow graph types;
- node và edge types;
- source mappings;
- change/event types;
- registry interfaces;
- schemas;
- validation primitives.

Không được phụ thuộc React.

---

## 7.2 `@codeflow/parser`

Chịu trách nhiệm:

- parse source;
- duy trì syntax tree;
- incremental parsing;
- parser abstraction.

Mục tiêu ban đầu:

- TypeScript;
- JavaScript.

---

## 7.3 `@codeflow/analyzer`

Chịu trách nhiệm:

- chuyển syntax thành semantic workflow nodes;
- phân tích control flow;
- phân tích data dependencies;
- resolve registered tools/functions;
- tạo graph edges;
- xác định vùng được hỗ trợ/không được hỗ trợ.

Đây là lớp intelligence chính của hệ thống.

---

## 7.4 `@codeflow/mapper`

Chịu trách nhiệm:

- stable node identity;
- source ranges;
- semantic paths;
- AST fingerprints;
- source-to-node mapping;
- node-to-source resolution.

---

## 7.5 `@codeflow/patcher`

Chịu trách nhiệm:

- apply node edits;
- AST transformations;
- source-preserving changes;
- minimal source patches;
- validation;
- conflict detection.

---

## 7.6 `@codeflow/registry`

Chịu trách nhiệm:

- node definitions;
- tool definitions;
- function metadata;
- input/output schemas;
- render metadata;
- editable properties;
- analyzers và patchers.

---

## 7.7 `@codeflow/mcp`

Adapter tùy chọn.

Chịu trách nhiệm:

- MCP tool discovery;
- chuyển MCP metadata thành CodeFlow tool definitions;
- mapping MCP tools vào CodeFlow registry.

Core không được bắt buộc phụ thuộc MCP.

---

## 7.8 `@codeflow/layout`

Chịu trách nhiệm:

- graph layout;
- automatic node positioning;
- layout configuration.

Implementation ban đầu: ELK.js.

---

## 7.9 `@codeflow/ui`

React-based workflow UI.

Chịu trách nhiệm:

- canvas;
- nodes;
- edges;
- node palette;
- inspector;
- controls;
- minimap;
- selection;
- workflow editing.

Implementation ban đầu: React Flow.

---

## 7.10 `@codeflow/code-editor`

Developer-oriented source editor.

Implementation ban đầu: Monaco Editor.

Chịu trách nhiệm:

- code editing;
- syntax highlighting;
- diagnostics;
- source diff;
- code view.

---

## 7.11 `@codeflow/react`

React integration layer.

Chịu trách nhiệm:

- providers;
- context;
- state synchronization;
- React hooks.

---

# 8. Core Data Model

## 8.1 WorkflowGraph

```ts
interface WorkflowGraph {
  id: string;
  version: number;
  source: SourceDocument;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  diagnostics: Diagnostic[];
}
```

## 8.2 WorkflowNode

```ts
interface WorkflowNode {
  id: string;
  type: NodeType;
  label: string;

  source: SourceMapping;

  inputs: NodePort[];
  outputs: NodePort[];

  metadata: Record<string, unknown>;

  capabilities: NodeCapabilities;
}
```

## 8.3 NodeType

Các type ban đầu:

```ts
type NodeType =
  | "trigger"
  | "tool"
  | "condition"
  | "loop"
  | "parallel"
  | "transform"
  | "code"
  | "merge"
  | "unknown";
```

Các node type mới phải có thể đăng ký qua registry.

---

# 9. Workflow Edges

Edge biểu diễn control flow hoặc data flow.

```ts
interface WorkflowEdge {
  id: string;

  source: string;
  target: string;

  kind: "control" | "data";

  sourcePort?: string;
  targetPort?: string;

  expression?: string;
}
```

Ví dụ data flow:

```text
Get PRs
   │
   └── data: prs ──→ For Each
```

Control flow:

```text
Condition ──control──→ Slack
```

---

# 10. Source Mapping

Mọi node có thể chỉnh sửa phải map được về một vùng source.

```ts
interface SourceMapping {
  file: string;

  start: SourcePosition;
  end: SourcePosition;

  semanticPath: string;

  fingerprint: string;
}
```

```ts
interface SourcePosition {
  line: number;
  column: number;
  offset: number;
}
```

Source mapping không được chỉ dựa vào line number.

---

# 11. Stable Node Identity

Node ID phải tồn tại qua:

- formatting;
- thêm line;
- thay đổi code không liên quan;
- di chuyển node trên UI;
- thay đổi source location.

Cơ chế resolve identity nên dùng theo thứ tự:

1. semantic path;
2. AST/subtree fingerprint;
3. source range;
4. structural context xung quanh.

Ví dụ:

```text
workflow.forEach.condition.slack.send
```

Node có thể chứa:

```ts
{
  id: "node_slack_01",
  semanticPath: "workflow.forEach.condition.slack.send",
  fingerprint: "sha256:...",
  source: {...}
}
```

---

# 12. Semantic Analyzer

Analyzer chuyển syntax thành semantic constructs.

## 12.1 Tool call

```ts
await github.getNewPRs();
```

→

```text
ToolNode
type: github.getNewPRs
```

## 12.2 Sequential execution

```ts
const a = await foo();
const b = await bar(a);
```

→

```text
Foo
 ↓
Bar
```

với data dependency:

```text
a → bar(a)
```

## 12.3 Condition

```ts
if (condition) {
  await foo();
}
```

→

```text
Condition
   │
   └── true → Foo
```

## 12.4 Else

```ts
if (condition) {
  await foo();
} else {
  await bar();
}
```

→

```text
        Condition
        /       \
     true       false
      ↓           ↓
     Foo         Bar
```

## 12.5 Loop

```ts
for (const item of items) {
  await process(item);
}
```

→

```text
Items
  ↓
For Each
  ↓
Process
```

## 12.6 Parallel

```ts
await Promise.all([
  foo(),
  bar(),
  baz()
]);
```

→

```text
       ┌→ Foo ─┐
Start ─┼→ Bar ─┼→ Merge
       └→ Baz ─┘
```

---

# 13. Code được hỗ trợ và không được hỗ trợ

CodeFlow không được cố visualize sai arbitrary code.

Ví dụ:

```ts
const result = extremelyComplexAlgorithm(data);
```

Nếu không có semantic definition:

```text
┌─────────────────────┐
│ Custom Code         │
│                     │
│ Complex logic       │
│ [View Code]         │
└─────────────────────┘
```

Source gốc phải được giữ nguyên.

---

# 14. Tool Registry

Tool được đăng ký độc lập với implementation.

```ts
interface ToolDefinition {
  name: string;
  label: string;
  description?: string;

  inputSchema: Schema;
  outputSchema?: Schema;

  icon?: string;

  editableFields?: EditableField[];

  analyzer?: SemanticAnalyzer;
  patcher?: NodePatcher;
}
```

Ví dụ:

```ts
registry.registerTool({
  name: "github.getFiles",
  label: "Get PR Files",

  inputSchema: {
    pr: "PullRequest"
  },

  outputSchema: "File[]"
});
```

Analyzer map:

```ts
await github.getFiles(pr);
```

thành registered tool.

---

# 15. MCP Adapter

MCP tools được chuyển thành `ToolDefinition`.

```text
MCP Server
    ↓
Tool Discovery
    ↓
MCP Adapter
    ↓
Tool Registry
    ↓
Semantic Analyzer
```

Source code vẫn là TypeScript bình thường.

Ví dụ:

```ts
await github.getFiles(pr);
```

Analyzer không cần biết `github.getFiles` đến từ:

- MCP;
- REST SDK;
- local function;
- generated SDK;
- custom plugin.

---

# 16. Custom Code

Custom function là first-class concept.

Ví dụ:

```ts
export function isAuthChange(files: File[]) {
  return files.some(file =>
    /auth|login|oauth|permission/i.test(file.path)
  );
}
```

System có thể expose:

```text
Is Auth Change

Input:
  files: File[]

Output:
  boolean

[Edit Code]
```

Custom code là escape hatch cho logic không nên bị chia thành quá nhiều visual node.

---

# 17. Node Registry và Plugin System

Toàn bộ visual semantics phải có khả năng mở rộng.

```ts
interface NodeDefinition {
  type: string;
  label: string;
  description?: string;

  inputSchema?: Schema;
  outputSchema?: Schema;

  editableFields?: EditableField[];

  renderer?: NodeRenderer;
  analyzer?: SemanticAnalyzer;
  patcher?: NodePatcher;
}
```

Plugin có thể đăng ký:

```ts
registry.registerNode(...);
registry.registerTool(...);
registry.registerAnalyzer(...);
```

---

# 18. Editable Properties

Mỗi node khai báo phần source mà nó cho phép edit an toàn.

Ví dụ:

```ts
await slack.send({
  channel: "#security",
  message: "Auth change detected"
});
```

Node definition:

```ts
editableFields: [
  "channel",
  "message"
]
```

UI có thể render:

```text
Channel
[#security       ]

Message
[Auth change detected]
```

Đổi `channel` chỉ được patch property tương ứng.

---

# 19. Expressions

Các giá trị đơn giản nên dùng expression syntax thân thiện.

Ví dụ:

```text
Security PR: {{ pr.title }}
```

Expression layer map thành TypeScript expression:

```ts
`Security PR: ${pr.title}`
```

Hỗ trợ ban đầu:

```text
{{ pr.title }}
{{ files.length }}
{{ user.email }}
```

Advanced mode cho phép viết trực tiếp code expression.

---

# 20. Patch Engine

Patch engine chịu trách nhiệm Workflow → Code.

Pipeline:

```text
Node ID
  ↓
Resolve source mapping
  ↓
Verify fingerprint
  ↓
Resolve AST node
  ↓
Validate edit
  ↓
Transform AST
  ↓
Generate minimal source patch
  ↓
Update source
  ↓
Re-analyze affected graph
```

Ví dụ:

```ts
patchNode({
  nodeId: "node_slack_01",
  changes: {
    channel: "#security-team"
  }
});
```

Kết quả:

```diff
- channel: "#security"
+ channel: "#security-team"
```

---

# 21. Conflict Detection

Trước khi patch:

1. resolve node;
2. compare fingerprint đã lưu;
3. kiểm tra source region;
4. phát hiện thay đổi bên ngoài.

Nếu source đã bị thay đổi:

```text
Conflict detected.

Workflow node này đã thay đổi kể từ lúc được load.

[Review]
[Keep Source]
[Apply Anyway]
```

Không được âm thầm overwrite thay đổi của user/AI.

---

# 22. Incremental Analysis

Source thay đổi chỉ nên trigger analysis ở vùng bị ảnh hưởng.

```text
Source Change
    ↓
Incremental Parse
    ↓
Changed AST Region
    ↓
Affected Semantic Nodes
    ↓
Graph Diff
    ↓
UI Update
```

Tree-sitter phù hợp cho incremental syntax analysis. TypeScript Compiler API/ts-morph dùng cho TypeScript-specific type/symbol information và AST manipulation khi cần.

---

# 23. Parser Strategy

Parser layer phải được abstraction.

```ts
interface Parser {
  parse(source: string): SyntaxTree;

  update(
    previous: SyntaxTree,
    source: string,
    changes: TextChange[]
  ): SyntaxTree;
}
```

Implementation ban đầu:

- Tree-sitter cho incremental syntax parsing;
- TypeScript Compiler API cho TypeScript semantics;
- ts-morph cho navigation/manipulation khi phù hợp.

Các phần còn lại của CodeFlow không được phụ thuộc trực tiếp vào parser internals.

---

# 24. UI Architecture

UI dùng React.

## 24.1 React Flow

Dùng cho:

- workflow canvas;
- node rendering;
- edge rendering;
- zoom/pan;
- selection;
- dragging;
- custom nodes;
- controls;
- minimap.

## 24.2 ELK.js

Chỉ dùng cho automatic graph layout.

Chịu trách nhiệm:

- node positions;
- branching;
- parallel branches;
- merge layout;
- spacing;
- nested graph layout.

ELK không hiểu source code hay workflow semantics.

## 24.3 Monaco Editor

Dùng cho:

- source editor;
- custom-code editor;
- code view;
- diff view;
- developer mode.

---

# 25. UI Components

`@codeflow/ui` cung cấp:

```tsx
<WorkflowCanvas />

<NodePalette />

<NodeInspector />

<NodeToolbar />

<WorkflowControls />

<WorkflowMiniMap />

<WorkflowNode />

<WorkflowEdge />

<CodePanel />

<CodeDiff />
```

---

# 26. Thiết kế Node UI

### Compact mode

```text
┌──────────────────┐
│ 🐙 Get PR Files  │
└──────────────────┘
```

### Expanded mode

```text
┌──────────────────────────┐
│ 🐙 Get PR Files          │
│                          │
│ PR                       │
│ {{ pr }}                 │
│                          │
│ Output: File[]           │
└──────────────────────────┘
```

### Developer mode

```text
┌──────────────────────────┐
│ </> Code                 │
│                          │
│ await github.getFiles(pr)│
└──────────────────────────┘
```

---

# 27. Progressive Disclosure

### Beginner

```text
Get PRs
  ↓
Check Auth
  ↓
Send Slack
```

### Power user

Node inspector:

```text
Repository
State
Channel
Message
Expressions
```

### Developer

Monaco:

```ts
await slack.send({
  channel: "#security"
});
```

---

# 28. Workflow Editing

User có thể:

- edit supported node properties;
- đổi tool parameters;
- edit conditions;
- chỉnh loop configuration;
- chỉnh expressions;
- tạo custom code nodes;
- replace supported nodes;
- thêm registered nodes.

UI phải thông báo rõ khi operation không được hỗ trợ.

---

# 29. Code ↔ Workflow Synchronization

Phải hỗ trợ cả hai chiều.

## Code → Workflow

```text
Source
 ↓
Parse
 ↓
Analyze
 ↓
Graph diff
 ↓
UI update
```

## Workflow → Code

```text
UI change
 ↓
Node change
 ↓
Resolve source
 ↓
Patch AST/source
 ↓
Source update
 ↓
Re-analyze
 ↓
Graph update
```

---

# 30. Graph Diff

Graph changes phải được biểu diễn rõ ràng.

```ts
interface GraphChange {
  type:
    | "node.added"
    | "node.removed"
    | "node.updated"
    | "edge.added"
    | "edge.removed";

  nodeId?: string;
  edgeId?: string;

  changes?: Record<string, unknown>;
}
```

Cho phép UI update hiệu quả và hỗ trợ debugging.

---

# 31. Diagnostics

Analyzer diagnostics:

```ts
interface Diagnostic {
  severity: "info" | "warning" | "error";

  code: string;

  message: string;

  source?: SourceMapping;
}
```

Ví dụ:

```text
Warning:
Function này không thể biểu diễn thành workflow node.

Error:
Không resolve được tool "github.getFiles".

Info:
Custom code được giữ nguyên nhưng không có semantic projection.
```

---

# 32. Layout

Layout package expose:

```ts
interface LayoutEngine {
  layout(graph: WorkflowGraph): LayoutResult;
}
```

Implementation ban đầu:

```text
@codeflow/layout
       ↓
     ELK.js
```

Layout không được thay đổi semantic graph.

Nó chỉ trả về:

```ts
interface LayoutResult {
  nodes: Record<string, {
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}
```

---

# 33. Runtime Independence

CodeFlow trả về source và graph representation.

Execution được giao cho hệ thống khác:

```text
CodeFlow
   │
   ├── Temporal
   ├── Inngest
   ├── BullMQ
   ├── Trigger.dev
   └── Custom Runtime
```

Runtime adapter có thể được thêm sau mà không thay đổi core model.

---

# 34. Security

Core không được execute arbitrary user code.

Custom code chỉ được:

- parse;
- analyze;
- display;
- patch.

Không được execute trong CodeFlow core.

Nếu sau này có runtime chạy user code, phải chạy trong môi trường isolation/sandbox phù hợp.

---

# 35. Public API

Ví dụ:

```ts
import {
  createCodeFlow
} from "@codeflow/core";

const flow = createCodeFlow({
  language: "typescript"
});

flow.registry.registerTool({
  name: "github.getNewPRs",
  label: "Get New PRs",
  inputSchema: {},
  outputSchema: "PullRequest[]"
});

const graph = await flow.analyze(source);
```

Patch:

```ts
const result = await flow.patchNode(
  "node_slack_01",
  {
    channel: "#security-team"
  }
);
```

Kết quả:

```ts
{
  source: updatedSource,
  patches: [...],
  graph: updatedGraph,
  diagnostics: [...]
}
```

---

# 36. React API

Ví dụ:

```tsx
<CodeFlowProvider
  graph={graph}
  registry={registry}
>
  <WorkflowCanvas
    editable
    layout="elk"
  />
</CodeFlowProvider>
```

Inspector:

```tsx
<NodeInspector
  nodeId={selectedNodeId}
/>
```

Code view:

```tsx
<CodeEditor
  source={source}
  language="typescript"
/>
```

---

# 37. Ví dụ End-to-End

Input:

```ts
const prs = await github.getNewPRs();

for (const pr of prs) {
  const files = await github.getFiles(pr);

  if (files.some(isAuthChange)) {
    await slack.send({
      channel: "#security",
      message: `Security PR: ${pr.title}`
    });
  }
}
```

Projection:

```text
┌──────────────┐
│ Get New PRs  │
└──────┬───────┘
       │ prs
       ▼
┌──────────────┐
│   For Each   │
└──────┬───────┘
       │ pr
       ▼
┌──────────────┐
│ Get PR Files │
└──────┬───────┘
       ▼
┌────────────────┐
│ Is Auth Change │
└───────┬────────┘
        │ true
        ▼
┌────────────────┐
│ Slack Send     │
│                │
│ #security      │
└────────────────┘
```

User đổi Slack channel:

```text
#security
    ↓
#security-team
```

Patch:

```diff
 await slack.send({
-  channel: "#security",
+  channel: "#security-team",
   message: `Security PR: ${pr.title}`
 });
```

Không regenerate các phần source khác.

---

# 38. Ví dụ Custom Code

User tạo:

```ts
export function isAuthChange(files: File[]) {
  return files.some(file =>
    /auth|login|oauth|permission/i.test(file.path)
  );
}
```

Registry metadata:

```ts
{
  name: "isAuthChange",
  kind: "function",
  inputSchema: {
    files: "File[]"
  },
  outputSchema: "boolean"
}
```

UI:

```text
┌───────────────────────┐
│ 🔐 Is Auth Change     │
│                       │
│ File[] → boolean      │
│                       │
│ [Edit Code]           │
└───────────────────────┘
```

---

# 39. Technology Stack

| Layer | Công nghệ | Vai trò |
|---|---|---|
| Language | TypeScript | Toàn bộ SDK |
| Parser | Tree-sitter | Incremental syntax parsing |
| TS semantics | TypeScript Compiler API | Types/symbols |
| AST manipulation | ts-morph | TypeScript navigation/manipulation |
| Graph | Custom CodeFlow model | Semantic representation |
| Layout | ELK.js | Automatic layout |
| Canvas | React Flow | Visual workflow editor |
| Code editor | Monaco | Developer/custom-code editor |
| UI primitives | shadcn/ui | Forms/inspector |
| MCP | MCP SDK | Tool integration |
| Unit test | Vitest | Core testing |
| E2E | Playwright | UI testing |
| Monorepo | pnpm + Turborepo | Package/build management |

---

# 40. Chiến lược Testing

## 40.1 Parser tests

Input code → expected syntax/semantic structure.

## 40.2 Analyzer tests

Input code → expected workflow graph.

## 40.3 Mapping tests

Đảm bảo node identity vẫn đúng sau:

- formatting;
- thêm code không liên quan;
- thay đổi line;
- source regeneration.

## 40.4 Patcher tests

Đảm bảo:

```text
Node edit
→ exact source patch
→ không có thay đổi ngoài ý muốn
```

## 40.5 Round-trip tests

Bắt buộc:

```text
Code
 ↓
Graph
 ↓
Edit
 ↓
Code
 ↓
Graph
```

Graph cuối phải giữ đúng semantics mong muốn.

## 40.6 UI tests

Dùng Playwright cho:

- drag/select;
- node editing;
- code view;
- conflict UI;
- workflow synchronization.

---

# 41. Performance Requirements

Với workflow file thông thường:

- initial analysis target: <500 ms;
- incremental graph update target: <50 ms khi khả thi;
- UI update phải incremental;
- layout chạy asynchronous;
- node không thay đổi không được re-render không cần thiết.

Đây là engineering targets, không phải semantic guarantees.

---

# 42. MVP Scope

Release đầu chỉ cần hỗ trợ:

### Language

- TypeScript;
- JavaScript.

### Semantics

- function/tool calls;
- variables;
- sequential `await`;
- `if/else`;
- `for...of`;
- `Promise.all`;
- registered functions;
- custom code fallback.

### Editing

- primitive arguments;
- object properties;
- expressions;
- condition expressions;
- tool selection.

### UI

- React Flow canvas;
- ELK auto-layout;
- node inspector;
- node palette;
- Monaco code view.

### Integration

- local function registry;
- basic MCP adapter.

---

# 43. MVP Acceptance Criteria

Project được xem là đã validate về mặt kỹ thuật khi hoàn thành được vòng:

```text
AI-generated TypeScript
        ↓
Automatic workflow visualization
        ↓
User chọn node
        ↓
User edit supported property
        ↓
Minimal source patch
        ↓
Source update
        ↓
Workflow update
```

Acceptance test:

Input:

```ts
await slack.send({
  channel: "#security"
});
```

User đổi:

```text
#security
→
#engineering
```

Expected:

```diff
- channel: "#security"
+ channel: "#engineering"
```

Không có thay đổi source không liên quan.

---

# 44. Future Extensions

Sau MVP có thể mở rộng:

- richer data-flow analysis;
- nested workflows;
- reusable subflows;
- visual debugging;
- execution tracing;
- runtime adapters;
- AI-assisted node editing;
- AI code generation từ workflow intent;
- multi-file workflows;
- Git-aware source mapping;
- semantic merge/conflict resolution;
- visual diff giữa workflow versions;
- hỗ trợ thêm language;
- workflow-to-code generation cho workflow mới;
- collaborative editing.

---

# 45. Architectural Constraint Quan Trọng

CodeFlow không được biến thành một workflow language thứ hai.

Không khuyến khích:

```text
Workflow JSON
    ↓
Custom Runtime
    ↓
Generated Code
```

Kiến trúc chuẩn:

```text
TypeScript Code
    ↓
Semantic Graph
    ↓
Visual Projection
```

Graph tồn tại để hiểu và chỉnh sửa code, không thay thế code.

---

# 46. Tóm tắt Kiến trúc

```text
                    ┌───────────────┐
                    │ AI / Developer│
                    └───────┬───────┘
                            │
                            ▼
                  ┌──────────────────┐
                  │ TypeScript Source│
                  │  SOURCE OF TRUTH │
                  └────────┬─────────┘
                           │
                     ┌─────▼─────┐
                     │  Parser   │
                     └─────┬─────┘
                           │
                  ┌────────▼────────┐
                  │ Semantic Engine │
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │ Workflow Graph  │
                  └────────┬────────┘
                           │
                    ┌──────▼──────┐
                    │    ELK.js   │
                    │    Layout   │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ React Flow  │
                    │     UI      │
                    └──────┬──────┘
                           │
                  ┌────────▼────────┐
                  │ Node Inspector  │
                  │ Custom Code     │
                  │ Monaco          │
                  └────────┬────────┘
                           │
                    ┌──────▼──────┐
                    │ Patch Engine │
                    └──────┬──────┘
                           │
                           ▼
                    TypeScript Source
```

## Core moat

Bốn phần cần tập trung engineering effort:

1. **Semantic Analyzer** — code → workflow có ý nghĩa.
2. **Stable Node Identity** — node tồn tại ổn định qua source changes.
3. **Source Mapping** — visual node map chính xác về code.
4. **Minimal Patch Engine** — visual edit chỉ sửa đúng source cần sửa.

React Flow, ELK.js, Monaco, Tree-sitter, ts-morph và MCP là infrastructure xung quanh core, không phải differentiator chính.
