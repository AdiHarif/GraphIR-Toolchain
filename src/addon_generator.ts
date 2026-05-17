
import * as ir from 'graphir';

export interface ExportedFunction {
    name: string;
    paramTypes: ir.Type[];
    returnType: ir.Type;
}

function irTypeToCpp(type: ir.Type): string {
    if (type instanceof ir.IntegerType) {
        if (type.width === 1) return 'bool';
        return `int${type.width}_t`;
    }
    if (type instanceof ir.FloatType) return type.width === 32 ? 'float' : 'double';
    if (type instanceof ir.NumberType) return 'double';
    if (type instanceof ir.VoidType) return 'void';
    if (type instanceof ir.UndefinedType) return 'Undefined';
    if (type instanceof ir.NullType) return 'Null';
    if (type instanceof ir.StaticStringType) return 'std::string';
    if (type instanceof ir.DynamicArrayType) return `DynamicArray<${irTypeToCpp(type.elementType)}>`;
    if (type instanceof ir.UnionType) return `Union<${type.types.map(irTypeToCpp).join(', ')}>`;
    if (type instanceof ir.OptionType) return `Union<${irTypeToCpp(type.baseType)}, Undefined>`;
    throw new Error(`Cannot map IR type to C++: ${type.constructor.name}`);
}

// Returns the non-Undefined member types of a UnionType.
function nonUndefinedTypes(type: ir.UnionType): ir.Type[] {
    return type.types.filter(t => !(t instanceof ir.UndefinedType));
}

// True if type is a UnionType that contains Undefined and exactly one value type.
function isOptionLikeUnion(type: ir.Type): type is ir.UnionType {
    if (!(type instanceof ir.UnionType)) return false;
    return type.types.some(t => t instanceof ir.UndefinedType) && nonUndefinedTypes(type).length === 1;
}

// For a Union<T, Undefined> value, return the C++ expression that produces the
// inner (non-Undefined) value. For scalars this requires a cast; for
// DynamicArray/nested-Union types the Union already supports .size() and
// operator[] so the expression can be used as-is.
function unionUnwrapExpr(valueType: ir.Type, cppExpr: string): string {
    if (valueType instanceof ir.IntegerType && valueType.width === 1) return `(bool)(${cppExpr})`;
    if (valueType instanceof ir.IntegerType) return `(int${valueType.width}_t)(double)(${cppExpr})`;
    if (valueType instanceof ir.FloatType || valueType instanceof ir.NumberType) return `(double)(${cppExpr})`;
    if (valueType instanceof ir.StaticStringType) return `(std::string)(${cppExpr})`;
    return cppExpr; // DynamicArray / nested Union: Union interface is compatible
}

// True if type supports .size() and operator[] and should be written back to JS.
function isArrayLike(type: ir.Type): boolean {
    if (type instanceof ir.DynamicArrayType) return true;
    if (type instanceof ir.OptionType) return type.baseType instanceof ir.DynamicArrayType;
    if (isOptionLikeUnion(type)) return nonUndefinedTypes(type)[0] instanceof ir.DynamicArrayType;
    return false;
}

// Returns [lines, cppVarName]
function genJsToCpp(type: ir.Type, jsExpr: string, varName: string, tmp: { n: number }): [string[], string] {
    const lines: string[] = [];

    if (type instanceof ir.IntegerType && type.width === 1) {
        lines.push(`bool ${varName} = ${jsExpr}.As<Napi::Boolean>().Value();`);
    } else if (type instanceof ir.IntegerType) {
        const ct = irTypeToCpp(type);
        lines.push(`${ct} ${varName} = static_cast<${ct}>(${jsExpr}.As<Napi::Number>().Int64Value());`);
    } else if (type instanceof ir.FloatType || type instanceof ir.NumberType) {
        lines.push(`${irTypeToCpp(type)} ${varName} = ${jsExpr}.As<Napi::Number>().DoubleValue();`);
    } else if (type instanceof ir.StaticStringType) {
        lines.push(`std::string ${varName} = ${jsExpr}.As<Napi::String>().Utf8Value();`);
    } else if (type instanceof ir.DynamicArrayType) {
        const jsArr = `_jsArr${tmp.n++}`;
        const loopI = `_i${tmp.n++}`;
        const inner = `_el${tmp.n++}`;
        lines.push(`Napi::Array ${jsArr} = ${jsExpr}.As<Napi::Array>();`);
        lines.push(`${irTypeToCpp(type)} ${varName}(0);`);
        lines.push(`for (uint32_t ${loopI} = 0; ${loopI} < ${jsArr}.Length(); ${loopI}++) {`);
        const [innerLines] = genJsToCpp(type.elementType, `${jsArr}.Get(${loopI})`, inner, tmp);
        for (const l of innerLines) lines.push(`    ${l}`);
        lines.push(`    ${varName}.push(${inner});`);
        lines.push(`}`);
    } else if (type instanceof ir.OptionType) {
        lines.push(`${irTypeToCpp(type)} ${varName};`);
        lines.push(`if (!${jsExpr}.IsUndefined()) {`);
        const inner = `_inner${tmp.n++}`;
        const [innerLines] = genJsToCpp(type.baseType, jsExpr, inner, tmp);
        for (const l of innerLines) lines.push(`    ${l}`);
        lines.push(`    ${varName} = ${inner};`);
        lines.push(`}`);
    } else if (isOptionLikeUnion(type)) {
        const valueType = nonUndefinedTypes(type)[0];
        lines.push(`${irTypeToCpp(type)} ${varName};`);
        lines.push(`if (!${jsExpr}.IsUndefined()) {`);
        const inner = `_inner${tmp.n++}`;
        const [innerLines] = genJsToCpp(valueType, jsExpr, inner, tmp);
        for (const l of innerLines) lines.push(`    ${l}`);
        lines.push(`    ${varName} = ${inner};`);
        lines.push(`}`);
    } else {
        throw new Error(`Cannot generate JS→C++ conversion for ${type.constructor.name}`);
    }

    return [lines, varName];
}

// Returns [setup lines, napi expression]
function genCppToJs(type: ir.Type, cppExpr: string, tmp: { n: number }): [string[], string] {
    if (type instanceof ir.VoidType) return [[], 'env.Undefined()'];
    if (type instanceof ir.IntegerType && type.width === 1) return [[], `Napi::Boolean::New(env, ${cppExpr})`];
    if (type instanceof ir.IntegerType || type instanceof ir.FloatType || type instanceof ir.NumberType) {
        return [[], `Napi::Number::New(env, ${cppExpr})`];
    }
    if (type instanceof ir.StaticStringType) return [[], `Napi::String::New(env, ${cppExpr})`];
    if (type instanceof ir.DynamicArrayType) {
        const jsArr = `_jsOut${tmp.n++}`;
        const loopI = `_i${tmp.n++}`;
        const lines: string[] = [];
        lines.push(`Napi::Array ${jsArr} = Napi::Array::New(env, ${cppExpr}.size());`);
        lines.push(`for (size_t ${loopI} = 0; ${loopI} < ${cppExpr}.size(); ${loopI}++) {`);
        const [innerLines, innerExpr] = genCppToJs(type.elementType, `${cppExpr}[${loopI}]`, tmp);
        for (const l of innerLines) lines.push(`    ${l}`);
        lines.push(`    ${jsArr}.Set((uint32_t)${loopI}, ${innerExpr});`);
        lines.push(`}`);
        return [lines, jsArr];
    }
    if (type instanceof ir.OptionType) {
        const resultVar = `_opt${tmp.n++}`;
        const lines: string[] = [];
        lines.push(`Napi::Value ${resultVar};`);
        lines.push(`if ((bool)(${cppExpr})) {`);
        const innerExpr = unionUnwrapExpr(type.baseType, cppExpr);
        const [innerLines, innerJsExpr] = genCppToJs(type.baseType, innerExpr, tmp);
        for (const l of innerLines) lines.push(`    ${l}`);
        lines.push(`    ${resultVar} = ${innerJsExpr};`);
        lines.push(`} else {`);
        lines.push(`    ${resultVar} = env.Undefined();`);
        lines.push(`}`);
        return [lines, resultVar];
    }
    if (isOptionLikeUnion(type)) {
        const valueType = nonUndefinedTypes(type as ir.UnionType)[0];
        const resultVar = `_union${tmp.n++}`;
        const lines: string[] = [];
        lines.push(`Napi::Value ${resultVar};`);
        lines.push(`if ((bool)(${cppExpr})) {`);
        const innerExpr = unionUnwrapExpr(valueType, cppExpr);
        const [innerLines, innerJsExpr] = genCppToJs(valueType, innerExpr, tmp);
        for (const l of innerLines) lines.push(`    ${l}`);
        lines.push(`    ${resultVar} = ${innerJsExpr};`);
        lines.push(`} else {`);
        lines.push(`    ${resultVar} = env.Undefined();`);
        lines.push(`}`);
        return [lines, resultVar];
    }
    throw new Error(`Cannot generate C++→JS conversion for ${type.constructor.name}`);
}

function innerElemType(type: ir.Type): ir.Type {
    if (type instanceof ir.DynamicArrayType) return type.elementType;
    if (type instanceof ir.OptionType) return (type.baseType as ir.DynamicArrayType).elementType;
    return (nonUndefinedTypes(type as ir.UnionType)[0] as ir.DynamicArrayType).elementType;
}

// Writes modified DynamicArray values back into the original JS array.
// DynamicArray uses shared_ptr so mutations inside the compiled function are
// already reflected in cppExpr. The caller guarantees the value is defined
// (not Undefined); undefined-ness is checked on the JS side before calling.
function genWriteBack(type: ir.Type, cppExpr: string, jsArr: string, tmp: { n: number }): string[] {
    if (!isArrayLike(type)) return [];
    return genWriteBackArray(innerElemType(type), cppExpr, jsArr, tmp);
}

function genWriteBackArray(elemType: ir.Type, cppExpr: string, jsArr: string, tmp: { n: number }): string[] {
    const loopI = `_iwb${tmp.n++}`;
    const lines: string[] = [];
    const elemExpr = `${cppExpr}[${loopI}]`;

    lines.push(`for (uint32_t ${loopI} = 0; ${loopI} < (uint32_t)${jsArr}.Length(); ${loopI}++) {`);

    if (isArrayLike(elemType)) {
        const innerJsArr = `_jsWbEl${tmp.n++}`;
        if (elemType instanceof ir.OptionType || isOptionLikeUnion(elemType)) {
            // Check JS-side for undefined before casting to Napi::Array,
            // avoiding Union::operator bool() on Union<DynamicArray, Undefined>.
            lines.push(`    if (!${jsArr}.Get(${loopI}).IsUndefined()) {`);
            lines.push(`        Napi::Array ${innerJsArr} = ${jsArr}.Get(${loopI}).As<Napi::Array>();`);
            const innerLines = genWriteBack(elemType, elemExpr, innerJsArr, tmp);
            for (const l of innerLines) lines.push(`        ${l}`);
            lines.push(`    }`);
        } else {
            lines.push(`    Napi::Array ${innerJsArr} = ${jsArr}.Get(${loopI}).As<Napi::Array>();`);
            const innerLines = genWriteBack(elemType, elemExpr, innerJsArr, tmp);
            for (const l of innerLines) lines.push(`    ${l}`);
        }
    } else {
        const [convLines, convExpr] = genCppToJs(elemType, elemExpr, tmp);
        for (const l of convLines) lines.push(`    ${l}`);
        lines.push(`    ${jsArr}.Set(${loopI}, ${convExpr});`);
    }

    lines.push(`}`);
    return lines;
}

function generateWrapper(func: ExportedFunction): string {
    const tmp = { n: 0 };
    const lines: string[] = [];

    lines.push(`Napi::Value Ductape_${func.name}(const Napi::CallbackInfo& info) {`);
    lines.push(`    Napi::Env env = info.Env();`);
    lines.push(``);

    const argVars: string[] = [];
    for (let i = 0; i < func.paramTypes.length; i++) {
        const argVar = `_arg${i}`;
        argVars.push(argVar);
        const [convLines] = genJsToCpp(func.paramTypes[i], `info[${i}]`, argVar, tmp);
        for (const l of convLines) lines.push(`    ${l}`);
    }

    lines.push(``);

    const argList = argVars.join(', ');
    if (func.returnType instanceof ir.VoidType) {
        lines.push(`    ${func.name}(${argList});`);
    } else {
        lines.push(`    ${irTypeToCpp(func.returnType)} _result = ${func.name}(${argList});`);
    }

    lines.push(``);

    for (let i = 0; i < func.paramTypes.length; i++) {
        const pt = func.paramTypes[i];
        if (!isArrayLike(pt)) continue;
        const isOptional = pt instanceof ir.OptionType || isOptionLikeUnion(pt);
        const jsArr = `_jsWb${tmp.n++}`;
        if (isOptional) {
            lines.push(`    if (!info[${i}].IsUndefined()) {`);
            lines.push(`        Napi::Array ${jsArr} = info[${i}].As<Napi::Array>();`);
            const wbLines = genWriteBack(pt, argVars[i], jsArr, tmp);
            for (const l of wbLines) lines.push(`        ${l}`);
            lines.push(`    }`);
        } else {
            lines.push(`    Napi::Array ${jsArr} = info[${i}].As<Napi::Array>();`);
            const wbLines = genWriteBack(pt, argVars[i], jsArr, tmp);
            for (const l of wbLines) lines.push(`    ${l}`);
        }
        lines.push(``);
    }

    if (func.returnType instanceof ir.VoidType) {
        lines.push(`    return env.Undefined();`);
    } else {
        const [retLines, retExpr] = genCppToJs(func.returnType, '_result', tmp);
        for (const l of retLines) lines.push(`    ${l}`);
        lines.push(`    return ${retExpr};`);
    }

    lines.push(`}`);
    lines.push(``);

    return lines.join('\n');
}

export function generateAddonCpp(funcs: ExportedFunction[]): string {
    const lines: string[] = [];

    lines.push('#include <napi.h>');
    lines.push('#include "DynamicArray.h"');
    lines.push('#include "union.h"');
    lines.push('');

    // Forward declarations — extern "C" matches what graphir-compiler emits
    for (const func of funcs) {
        const params = func.paramTypes.map((t, i) => `${irTypeToCpp(t)} p${i}`).join(', ');
        lines.push(`extern "C" ${irTypeToCpp(func.returnType)} ${func.name}(${params});`);
    }
    lines.push('');

    for (const func of funcs) {
        lines.push(generateWrapper(func));
    }

    lines.push('Napi::Object Init(Napi::Env env, Napi::Object exports) {');
    for (const func of funcs) {
        lines.push(`    exports.Set("${func.name}", Napi::Function::New(env, Ductape_${func.name}));`);
    }
    lines.push('    return exports;');
    lines.push('}');
    lines.push('');
    lines.push('NODE_API_MODULE(ductape_addon, Init)');

    return lines.join('\n');
}

export function generateBindingGyp(): string {
    return JSON.stringify({
        make_global_settings: [
            ['CXX', '/usr/bin/clang++'],
            ['CC', '/usr/bin/clang'],
        ],
        targets: [{
            target_name: 'addon',
            sources: ['addon.cpp', 'out/tmp.cpp'],
            include_dirs: [
                `<!@(node -p "require('node-addon-api').include")`,
                'node_modules/graphir-compiler/lib',
            ],
            'cflags!': ['-fno-exceptions'],
            'cflags_cc!': ['-fno-exceptions'],
            cflags_cc: ['-std=c++17', '-O3', '-Wno-narrowing'],
            defines: ['NAPI_CPP_EXCEPTIONS'],
        }],
    }, null, 2);
}
