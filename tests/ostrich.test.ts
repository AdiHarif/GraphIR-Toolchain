
import fs from "fs"
import { execSync } from "child_process"

beforeEach(() => {
    fs.rmSync("out", { recursive: true, force: true});
    fs.mkdirSync("out");
});

const results: any = {};

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
});

function runDuctape(tsFile: string) {
    const execFile = 'out/a.out';
    execSync(`npm start -- -i ${tsFile} -o ${execFile}`, { stdio: 'ignore', timeout: 30000 });
    const nativeStartTime = process.hrtime();
    execSync(`${execFile}`, { stdio: 'ignore', timeout: 30000 });
    const ductapeEndTime = process.hrtime(nativeStartTime);
    const ductapeTime = ductapeEndTime[0] + ductapeEndTime[1] / 1e9;

    return ductapeTime;
}

function runNative(benchmark: string) {
    const dir = `submodules/TS-Ostrich/native/${benchmark}`;
    const out = execSync(`make build/c/run.sh`, { stdio: 'ignore', timeout: 30000, cwd: dir });
    const nativeStartTime = process.hrtime();
    execSync(`./build/c/run.sh`, { timeout: 30000, cwd: dir });
    const nativeEndTime = process.hrtime(nativeStartTime);
    const nativeTime = nativeEndTime[0] + nativeEndTime[1] / 1e9;

    return nativeTime;
}

function runJS(tsFile: string, jitless = false) {
    const outDir = 'out';
    execSync(`tsc --outDir ${outDir} --skipLibCheck ${tsFile} --target ESNext`, { stdio: 'ignore', timeout: 30000 });
    const tsStartTime = process.hrtime();
    execSync(`node ${jitless ? '--jitless' : ''} ${outDir}/*.js`, { stdio: 'ignore', timeout: jitless ? 300000 : 30000 });
    const endTime = process.hrtime(tsStartTime);
    const jsTime = endTime[0] + endTime[1] / 1e9;

    return jsTime;
}

function runBenchmark(benchmark: string) {
    let jitlessTime = 0;
    let jsTime = 0;
    let ductapeTime = 0;
    let nativeTime = 0;

    const iterations = 10;
    for (let i = 0; i < iterations; i++) {
        const tsFile = `submodules/TS-Ostrich/benchmarks/${benchmark}.ts`;
        jitlessTime += runJS(tsFile, true);
        jsTime += runJS(tsFile);
        ductapeTime += runDuctape(tsFile);
        nativeTime += runNative(benchmark);
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
}


describe("Ostrich Benchmarks", () => {
    for (const benchmark of supported) {
        test(benchmark, () => {
            runBenchmark(benchmark);
        });
    }
});
