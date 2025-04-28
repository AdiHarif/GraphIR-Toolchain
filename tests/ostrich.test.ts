
import fs from "fs"
import { execSync } from "child_process"

beforeEach(() => {
    fs.rmSync("out", { recursive: true, force: true});
    fs.mkdirSync("out");
});

const results: any = {};
const memory: any = {};

function runWithMeasure(cmd: string, args: any) {
    const exec = "/usr/bin/time"
    const tsStartTime = process.hrtime();
    const out = execSync(`${exec} -v ${cmd} 2>&1`, {...args});
    console.log(out.toString());
    const endTime = process.hrtime(tsStartTime);
    const time = endTime[0] + endTime[1] / 1e9;
    const memory = parseInt(out.toString().split("Maximum resident set size (kbytes): ")[1].split("\n")[0], 10);
    return { time, memory };
}

const supported = [
    "bfs",
    "crc",
    "fft",
    "lud",
    "needle",
    "pagerank"
]

afterAll(() => {
    if (Object.keys(results).length < supported.length) {
        return;
    }

    const outpath = "ostrich.csv";
    fs.writeFileSync(outpath, "Benchmark,Node (JIT-less),Node,DUCTAPE,Handcrafted Native\n");
    for (const benchmark in results) {
        const {jitlessTime, jsTime, ductapeTime, nativeTime} = results[benchmark];
        fs.appendFileSync(outpath, `${benchmark},${jitlessTime},${jsTime},${ductapeTime},${nativeTime}\n`);
    }

    const memoryPath = "ostrich_memory.csv";
    fs.writeFileSync(memoryPath, "Benchmark,Node (JIT-less),Node,DUCTAPE,Handcrafted Native\n");
    for (const benchmark in memory) {
        const {jitlessMemory, jsMemory, ductapeMemory, nativeMemory} = memory[benchmark];
        fs.appendFileSync(memoryPath, `${benchmark},${jitlessMemory},${jsMemory},${ductapeMemory},${nativeMemory}\n`);
    }
});

function runDuctape(tsFile: string) {
    const execFile = 'out/a.out';
    execSync(`npm start -- -i ${tsFile} -o ${execFile}`, { stdio: 'ignore', timeout: 30000 });
    return runWithMeasure(`${execFile}`, { timeout: 30000 });
}

function runNative(benchmark: string) {
    return {time: 0, memory: 0};
}

function runJS(tsFile: string, jitless = false) {
    const outDir = 'out';
    execSync(`tsc --outDir ${outDir} --skipLibCheck ${tsFile} --target ESNext`, { stdio: 'ignore', timeout: 30000 });
    return runWithMeasure(`node ${jitless ? '--jitless' : ''} ${outDir}/*.js`, { timeout: jitless ? 300000 : 30000 });
}

function runBenchmark(benchmark: string) {
    let jitlessTime = 0;
    let jsTime = 0;
    let ductapeTime = 0;
    let nativeTime = 0;

    let jitlessMemory = 0;
    let jsMemory = 0;
    let ductapeMemory = 0;
    let nativeMemory = 0;

    let out: any = {};

    const iterations = 1;
    for (let i = 0; i < iterations; i++) {
        const tsFile = `submodules/TS-Ostrich/benchmarks/${benchmark}.ts`;

        out = runJS(tsFile, true);
        jitlessTime += out['time'];
        jitlessMemory += out['memory'];

        out = runJS(tsFile);
        jsTime += out['time'];
        jsMemory += out['memory'];

        out = runDuctape(tsFile);
        ductapeTime += out['time'];
        ductapeMemory += out['memory'];

        out = runNative(benchmark);
        nativeTime += out['time'];
        nativeMemory += out['memory'];
    }

    jitlessTime /= iterations;
    jsTime /= iterations;
    ductapeTime /= iterations;
    nativeTime /= iterations;

    results[benchmark] = {
        jitlessTime,
        jsTime,
        ductapeTime,
        nativeTime
    };

    jitlessMemory /= iterations;
    jsMemory /= iterations;
    ductapeMemory /= iterations;
    nativeMemory /= iterations;

    memory[benchmark] = {
        jitlessMemory,
        jsMemory,
        ductapeMemory,
        nativeMemory
    };
}


describe("Ostrich Benchmarks", () => {
    for (const benchmark of supported) {
        test(benchmark, () => {
            runBenchmark(benchmark);
        });
    }
});
