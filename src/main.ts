
import fs from 'fs';
import { execSync } from 'child_process';

import { exportIrToRelations } from "graphir";
import * as ir from 'graphir';
import { extractFromPath } from 'ts-graph-extractor';
import { generateCpp, generateGlobalsStruct } from 'graphir-compiler';

import { getCliOptions } from "./options.js";
import { generateContext } from './context_manager.js';
import { hydrateTypesFromFiles, typeNameToType } from './type_hydration.js';
import { transformGraph } from './transformation.js';
import { generateAddonCpp, generateBindingGyp, ExportedFunction } from './addon_generator.js';

const options = getCliOptions();

function parseExportedFunctions(filePath: string): string[] {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const exported: string[] = [];
    for (let i = 0; i < lines.length - 1; i++) {
        if (/^\s*\/\/\s*@ductape-export\s*$/.test(lines[i])) {
            const match = lines[i + 1].match(/^\s*function\s+(\w+)/);
            if (match) exported.push(match[1]);
        }
    }
    return exported;
}

function findSubgraphByName(graph: ir.Graph, name: string): ir.Graph | undefined {
    for (const subgraph of graph.subgraphs) {
        if (subgraph.getStartVertex().inEdges.length > 0) {
            const symbol = subgraph.getStartVertex().inEdges[0].source;
            if (symbol instanceof ir.StaticSymbolVertex && symbol.name === name) {
                return subgraph;
            }
        }
        const found = findSubgraphByName(subgraph, name);
        if (found) return found;
    }
    return undefined;
}

// Build a map from StartVertex id to its containing subgraph, for every
// subgraph in the hierarchy rooted at graph.
function buildStartVertexMap(graph: ir.Graph, map: Map<number, ir.Graph>): void {
    for (const subgraph of graph.subgraphs) {
        map.set(subgraph.getStartVertex().id, subgraph);
        buildStartVertexMap(subgraph, map);
    }
}

// Collect the set of all subgraphs transitively reachable from seeds via
// direct function calls (CallVertex → StaticSymbolVertex → startVertex).
// Also includes sub-subgraphs (closures) of every reachable graph.
function collectReachableSubgraphs(rootGraph: ir.Graph, seeds: ir.Graph[]): Set<ir.Graph> {
    const startMap = new Map<number, ir.Graph>();
    buildStartVertexMap(rootGraph, startMap);

    const reachable = new Set<ir.Graph>();

    function visit(subgraph: ir.Graph): void {
        if (reachable.has(subgraph)) return;
        reachable.add(subgraph);

        for (const vertex of subgraph.vertices) {
            if (vertex.kind === ir.VertexKind.Call) {
                const callee = (vertex as ir.CallVertex).callee;
                if (callee instanceof ir.StaticSymbolVertex && callee.startVertex) {
                    const calleeGraph = startMap.get(callee.startVertex.id);
                    if (calleeGraph) visit(calleeGraph);
                }
            }
        }

        for (const sub of subgraph.subgraphs) {
            visit(sub);
        }
    }

    for (const seed of seeds) visit(seed);
    return reachable;
}

// Build a root ir.Graph that contains only the direct children of rootGraph
// that are in the reachable set. The new root has a fresh StartVertex with no
// outgoing edges, which makes generateCpp emit an empty main() that references
// no missing symbols.
function buildFilteredGraph(rootGraph: ir.Graph, reachable: Set<ir.Graph>): ir.Graph {
    const filteredRoot = new ir.Graph();
    filteredRoot.setStartVertex(new ir.StartVertex());
    filteredRoot.verifiedType = new ir.FunctionType(new ir.IntegerType(32), []);

    for (const subgraph of rootGraph.subgraphs) {
        if (reachable.has(subgraph)) {
            filteredRoot.addSubgraph(subgraph);
        }
    }

    return filteredRoot;
}

async function prepareGraph(inputFile: string): Promise<{ graph: ir.Graph, cppFile: string }> {
    const graph = extractFromPath(inputFile);
    await exportIrToRelations(graph, 'out');

    execSync(`souffle -D../../out -F../../out src/main.dl`, { cwd: "submodules/GraphIR-Static-Analysis" });
    hydrateTypesFromFiles(graph, 'out/full_type.csv');

    const cppFile = 'out/tmp.cpp';
    fs.writeFileSync(cppFile, '');

    const contextManager = generateContext(graph);
    contextManager.dump(cppFile);

    const lines = fs.readFileSync('out/global_variable.csv').toString().split('\n');
    const fields: Array<[string, ir.Type]> = lines.filter(line => line != '')
        .map(line => line.split('\t'))
        .map(line => [line[0], typeNameToType(line[1])]);

    fs.appendFileSync(cppFile, generateGlobalsStruct(fields), { flag: 'a' });

    transformGraph(graph, 'out/graph_transformation.csv');

    return { graph, cppFile };
}

function compileNormal(graph: ir.Graph, cppFile: string): void {
    fs.appendFileSync(cppFile, generateCpp(graph), { flag: 'a' });
    execSync(`clang++ -O3 -Wno-narrowing -std=c++17 -o ${options['output-file']} -Inode_modules/graphir-compiler/lib ${cppFile}`);
}

function compileGradual(graph: ir.Graph, cppFile: string, exportedFunctionNames: string[]): void {
    const exportedFunctions: ExportedFunction[] = exportedFunctionNames.map(name => {
        const subgraph = findSubgraphByName(graph, name);
        if (!subgraph) throw new Error(`Function '${name}' not found in graph`);
        const funcType = subgraph.verifiedType;
        if (!(funcType instanceof ir.FunctionType)) throw new Error(`'${name}' did not get a FunctionType after hydration`);
        return { name, paramTypes: funcType.parameterTypes, returnType: funcType.returnType };
    });

    const exportedSubgraphs = exportedFunctionNames.map(n => findSubgraphByName(graph, n)!);
    const reachable = collectReachableSubgraphs(graph, exportedSubgraphs);
    const filteredGraph = buildFilteredGraph(graph, reachable);

    // generateCpp always appends the root graph's own function last.
    // For a shared library there is no entry point, so strip it.
    const rawCode = generateCpp(filteredGraph);
    const code = rawCode.replace(/\nextern "C" \S+ main\(.*$/s, '\n');
    fs.appendFileSync(cppFile, code, { flag: 'a' });

    fs.writeFileSync('addon.cpp', generateAddonCpp(exportedFunctions));
    fs.writeFileSync('binding.gyp', generateBindingGyp());
    execSync('npx node-gyp rebuild', { stdio: 'inherit' });
    console.log('Addon built: build/Release/addon.node');
}

async function main() {
    const { graph, cppFile } = await prepareGraph(options['input-file']);

    if (options['compilation-mode'] === 'gradual') {
        const exportedFunctionNames = parseExportedFunctions(options['input-file']);
        compileGradual(graph, cppFile, exportedFunctionNames);
    } else {
        compileNormal(graph, cppFile);
    }
}

main();
