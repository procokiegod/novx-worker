import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import pLimit from 'p-limit';
import { createClient } from '@supabase/supabase-js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import archiver from 'archiver';
import { createWriteStream } from 'node:fs';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  WORKER_SECRET: z.string().min(24),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_STORAGE_BUCKET: z.string().default('builds'),
  MAX_CONCURRENT_BUILDS: z.coerce.number().int().min(1).max(8).default(2),
  BUILD_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
  MAX_FILES: z.coerce.number().int().min(1).max(500).default(120),
  MAX_TOTAL_SOURCE_BYTES: z.coerce.number().int().min(10_000).max(20_000_000).default(2_000_000),
});

const env = envSchema.parse(process.env);

const fileSchema = z.object({
  path: z.string().min(1).max(300),
  content: z.string().max(500_000),
  language: z.string().max(40).optional().default('text'),
});

const compileRequestSchema = z.object({
  projectId: z.string().uuid(),
  files: z.array(fileSchema).min(1).max(env.MAX_FILES),
  options: z.object({
    pluginName: z.string().min(1).max(80).optional(),
    mcVersion: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/).optional(),
    javaVersion: z.union([z.string(), z.number()]).optional(),
    mainClass: z.string().max(200).optional(),
    packageName: z.string().max(200).optional(),
    platform: z.string().max(40).optional(),
  }).passthrough().optional().default({}),
  spec: z.unknown().optional(),
});

type CompileRequest = z.infer<typeof compileRequestSchema>;

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '3mb' }));

const limiter = pLimit(env.MAX_CONCURRENT_BUILDS);
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function requireWorkerSecret(req: express.Request, res: express.Response, next: express.NextFunction) {
  const auth = req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (!token || !timingSafeStringEqual(token, env.WORKER_SECRET)) {
    res.status(401).json({ error: 'Unauthorized worker request' });
    return;
  }

  next();
}

function safeRelativePath(input: string): string {
  const normalized = input.replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = normalized.split('/');

  if (
    !normalized ||
    normalized.includes('\0') ||
    parts.some((part) => part === '..' || part === '')
  ) {
    throw new Error(`Unsafe file path: ${input}`);
  }

  return normalized;
}

function sanitizeArtifactName(input: string): string {
  const value = input
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return value || 'NovxPlugin';
}

function paperApiVersion(mcVersion: string): string {
  return `${mcVersion}-R0.1-SNAPSHOT`;
}

function trustedPom(pluginName: string, mcVersion: string, javaVersion: string): string {
  const artifactId = sanitizeArtifactName(pluginName).toLowerCase();

  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <groupId>fun.novx.generated</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>1.0.0</version>
  <packaging>jar</packaging>

  <properties>
    <maven.compiler.release>${javaVersion}</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>

  <repositories>
    <repository>
      <id>papermc</id>
      <url>https://repo.papermc.io/repository/maven-public/</url>
    </repository>
  </repositories>

  <dependencies>
    <dependency>
      <groupId>io.papermc.paper</groupId>
      <artifactId>paper-api</artifactId>
      <version>${paperApiVersion(mcVersion)}</version>
      <scope>provided</scope>
    </dependency>
  </dependencies>

  <build>
    <finalName>${sanitizeArtifactName(pluginName)}</finalName>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.13.0</version>
        <configuration>
          <release>${javaVersion}</release>
        </configuration>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-jar-plugin</artifactId>
        <version>3.4.2</version>
      </plugin>
    </plugins>
  </build>
</project>`;
}

async function writeTrustedProject(root: string, body: CompileRequest): Promise<void> {
  const totalBytes = body.files.reduce(
    (sum, file) => sum + Buffer.byteLength(file.content, 'utf8'),
    0,
  );

  if (totalBytes > env.MAX_TOTAL_SOURCE_BYTES) {
    throw new Error(`Project exceeds ${env.MAX_TOTAL_SOURCE_BYTES} bytes`);
  }

  for (const file of body.files) {
    const rel = safeRelativePath(file.path);

    // Never allow generated projects to control Maven itself.
    if (
      rel === 'pom.xml' ||
      rel.startsWith('.mvn/') ||
      rel === 'mvnw' ||
      rel === 'mvnw.cmd'
    ) {
      continue;
    }

    const target = path.join(root, rel);
    const resolved = path.resolve(target);
    const rootResolved = path.resolve(root) + path.sep;

    if (!resolved.startsWith(rootResolved)) {
      throw new Error(`Unsafe resolved path: ${rel}`);
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, 'utf8');
  }

  const pluginName = body.options.pluginName || 'NovxPlugin';
  const mcVersion = body.options.mcVersion || '1.21.1';
  const requestedJava = String(body.options.javaVersion || '21');
  const javaVersion = requestedJava === '17' ? '17' : '21';

  await fs.writeFile(
    path.join(root, 'pom.xml'),
    trustedPom(pluginName, mcVersion, javaVersion),
    'utf8',
  );
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; logs: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '/tmp',
        MAVEN_OPTS: '-Xms64m -Xmx768m -XX:MaxMetaspaceSize=256m',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let logs = '';
    const maxLogChars = 500_000;

    const append = (chunk: Buffer) => {
      if (logs.length < maxLogChars) {
        logs += chunk.toString('utf8').slice(0, maxLogChars - logs.length);
      }
    };

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', reject);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Build timed out after ${timeoutMs}ms\n${logs}`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, logs });
    });
  });
}

async function createZip(sourceDir: string, outputFile: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outputFile);
    const zip = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    output.on('error', reject);
    zip.on('error', reject);

    zip.pipe(output);
    zip.glob('**/*', {
      cwd: sourceDir,
      ignore: ['target/**'],
      dot: true,
    });
    void zip.finalize();
  });
}

async function uploadArtifact(localPath: string, remotePath: string, contentType: string): Promise<void> {
  const bytes = await fs.readFile(localPath);
  const { error } = await supabase.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .upload(remotePath, bytes, {
      contentType,
      upsert: true,
    });

  if (error) {
    throw new Error(`Supabase upload failed: ${error.message}`);
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'novx-worker',
    java: 21,
    concurrentBuilds: env.MAX_CONCURRENT_BUILDS,
  });
});

app.post('/compile', requireWorkerSecret, async (req, res) => {
  const parsed = compileRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: 'Invalid compile request',
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    const result = await limiter(async () => {
      const body = parsed.data;
      const buildId = randomUUID();
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novx-build-'));

      try {
        await writeTrustedProject(tempRoot, body);

        const build = await runCommand(
          'mvn',
          ['--batch-mode', '--no-transfer-progress', 'clean', 'package'],
          tempRoot,
          env.BUILD_TIMEOUT_MS,
        );

        if (build.code !== 0) {
          return {
            success: false,
            error: 'Maven compilation failed',
            logs: build.logs,
            attempts: 1,
          };
        }

        const targetDir = path.join(tempRoot, 'target');
        const targetEntries = await fs.readdir(targetDir);
        const jarName = targetEntries.find(
          (name) =>
            name.endsWith('.jar') &&
            !name.endsWith('-sources.jar') &&
            !name.startsWith('original-'),
        );

        if (!jarName) {
          return {
            success: false,
            error: 'Maven succeeded but produced no JAR',
            logs: build.logs,
            attempts: 1,
          };
        }

        const artifactBase = sanitizeArtifactName(body.options.pluginName || 'NovxPlugin');
        const sourceZipPath = path.join(tempRoot, `${artifactBase}-source.zip`);
        await createZip(tempRoot, sourceZipPath);

        const remoteBase = `builds/${body.projectId}/${buildId}`;
        const jarRemotePath = `${remoteBase}/${artifactBase}.jar`;
        const zipRemotePath = `${remoteBase}/${artifactBase}-source.zip`;

        await uploadArtifact(
          path.join(targetDir, jarName),
          jarRemotePath,
          'application/java-archive',
        );
        await uploadArtifact(
          sourceZipPath,
          zipRemotePath,
          'application/zip',
        );

        return {
          success: true,
          logs: build.logs,
          jarPath: jarRemotePath,
          zipPath: zipRemotePath,
          attempts: 1,
        };
      } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    });

    res.status(result.success ? 200 : 422).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown worker failure';
    res.status(500).json({
      success: false,
      error: message,
      logs: message,
      attempts: 1,
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`NOVX worker listening on port ${env.PORT}`);
});
