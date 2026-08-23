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

/** One syntactic error, in offsets — line/column is the caller's to derive. */
export interface ParseError {
  message: string;
  /** 0-based offset, or undefined when the error has no position. */
  start: number | undefined;
  length: number | undefined;
}

export interface TsMorphParserOptions {
  /** Document path used for source files parsed without an explicit path. */
  file?: string;
}

/** U+FEFF, a byte-order mark, when it opens the document. */
const BOM = 0xfeff;

/**
 * The text handed to ts-morph, in the caller's coordinate space.
 *
 * ts-morph strips a leading BOM from the text it parses (it remembers it for
 * `save()`), which would put every AST offset one character ahead of the source
 * the caller holds: node ranges would point one character short, the UI would
 * highlight the wrong text, and every patch would land in the wrong place. A
 * BOM is whitespace to the scanner, so substituting a single space keeps the
 * two coordinate spaces identical without changing one token — and the document
 * the graph carries (and that patches are applied to) keeps its BOM.
 */
function forParser(source: string): string {
  return source.charCodeAt(0) === BOM ? ` ${source.slice(1)}` : source;
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
    const sourceFile = this.project.createSourceFile(path, forParser(source), { overwrite: true });
    return { file, content: source, sourceFile };
  }

  /**
   * Syntactic errors of a tree this parser produced — the "does it parse" half
   * of the L0 gate (10 §5).
   *
   * Syntactic only, never semantic: the project runs with `noLib`/`noResolve`
   * (a flow's imports point at artifacts that exist in the workspace, not here),
   * so semantic diagnostics would be noise. Type-checking, when a validation
   * environment has one, is the host's to add (10 §5).
   */
  syntaxErrors(tree: TsSyntaxTree): ParseError[] {
    const program = this.project.getProgram().compilerObject;
    return program.getSyntacticDiagnostics(tree.sourceFile.compilerNode).map((diagnostic) => ({
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      start: diagnostic.start,
      length: diagnostic.length,
    }));
  }

  /** MVP: full re-parse. `previous` and `changes` are accepted for contract parity. */
  update(_previous: SyntaxTree, source: string, _changes: TextChange[]): TsSyntaxTree {
    return this.parse(source);
  }
}

export function createParser(options: TsMorphParserOptions = {}): TsMorphParser {
  return new TsMorphParser(options);
}
