/**
 * Parser layer — 02-architecture.md §3.
 *
 * MVP implementation: TypeScript Compiler API through ts-morph. `update` is a
 * full re-parse; the `Parser` contract stays the same if an incremental
 * implementation (Tree-sitter) is swapped in later.
 *
 * Browser-safe: the project uses ts-morph's in-memory file system and never
 * loads lib files — the analysis path needs parse + scope analysis only, never
 * the type checker (04 §1.2).
 */

import { Project, ts, type SourceFile } from "ts-morph";
import type { Parser, SyntaxTree, TextChange } from "../model/index.js";

/** Default document path used when the caller does not supply one. */
export const DEFAULT_FLOW_FILE = "flow.ts";

/** The concrete syntax tree produced by {@link TsMorphParser}. */
export interface TsSyntaxTree extends SyntaxTree {
  readonly file: string;
  readonly content: string;
  readonly sourceFile: SourceFile;
}

export interface TsMorphParserOptions {
  /** Document path used for source files parsed without an explicit path. */
  file?: string;
}

export function isTsSyntaxTree(tree: SyntaxTree): tree is TsSyntaxTree {
  const candidate = tree as Partial<TsSyntaxTree>;
  return (
    typeof candidate.file === "string" &&
    typeof candidate.content === "string" &&
    typeof candidate.sourceFile === "object" &&
    candidate.sourceFile !== null
  );
}

export class TsMorphParser implements Parser {
  private readonly project: Project;
  private readonly defaultFile: string;

  constructor(options: TsMorphParserOptions = {}) {
    this.defaultFile = options.file ?? DEFAULT_FLOW_FILE;
    this.project = new Project({
      useInMemoryFileSystem: true,
      skipLoadingLibFiles: true,
      skipFileDependencyResolution: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        allowJs: false,
        noLib: true,
        noResolve: true,
      },
    });
  }

  /**
   * Parse `source`. The project is kept warm across calls (02 §4) — the file is
   * overwritten rather than a new project being built.
   */
  parse(source: string, file: string = this.defaultFile): TsSyntaxTree {
    const path = file.startsWith("/") ? file : `/${file}`;
    const sourceFile = this.project.createSourceFile(path, source, { overwrite: true });
    return { file, content: source, sourceFile };
  }

  /** MVP: full re-parse. `previous` and `changes` are accepted for contract parity. */
  update(_previous: SyntaxTree, source: string, _changes: TextChange[]): TsSyntaxTree {
    return this.parse(source);
  }
}

export function createParser(options: TsMorphParserOptions = {}): TsMorphParser {
  return new TsMorphParser(options);
}
