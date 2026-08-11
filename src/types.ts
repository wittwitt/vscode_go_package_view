// Raw package info from `go list -json`
export interface GoPackageInfo {
  ImportPath: string;
  Name: string;
  Standard: boolean;
  GoFiles: string[];
  CgoFiles?: string[];
  TestGoFiles?: string[];
  XTestGoFiles?: string[];
  Imports: string[];
  Dir?: string;
  Module?: {
    Path: string;
    Main?: boolean;
    Dir?: string;
  };
}

export interface SearchableGoFile {
  filePath: string;
  fileName: string;
  importPath: string;
}

// Parsed result cached in memory
export interface ParsedData {
  modulePath: string;
  packages: Map<string, GoPackageInfo>;
  mainPkgs: GoPackageInfo[];
}

// Mode for constructing the tree
export type TreeMode = 'normal' | 'library';

// Element types passed around in the TreeDataProvider
export type ViewElementKind = 'package' | 'file';

export interface ViewElement {
  kind: ViewElementKind;
  /** The import path this element belongs to / represents */
  importPath: string;
  label: string;
  fileName?: string;
  filePath?: string;
  /** Whether this is in library (reverse tree) mode */
  libraryMode?: boolean;
}
