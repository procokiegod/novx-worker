import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import pLimit from 'p-limit';
import { createClient } from '@supabase/supabase-js';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import archiver from 'archiver';

/*
|--------------------------------------------------------------------------
| Environment variables
|--------------------------------------------------------------------------
*/

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),

  WORKER_SECRET: z.string().min(24),

  SUPABASE_URL: z.string().url(),

  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  SUPABASE_STORAGE_BUCKET: z.string().default('builds'),

  MAX_CONCURRENT_BUILDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(8)
    .default(2),

  BUILD_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(600_000)
    .default(120_000),

  MAX_FILES: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .default(120),

  MAX_TOTAL_SOURCE_BYTES: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(20_000_000)
    .default(2_000_000),
});

const env = envSchema.parse(process.env);

/*
|--------------------------------------------------------------------------
| Request validation
|--------------------------------------------------------------------------
*/

const fileSchema = z.object({
  path: z.string().min(1).max(500),

  content: z
    .union([z.string(), z.null(), z.undefined()])
    .transform((value) => value ?? ''),

  language: z
    .union([z.string(), z.null(), z.undefined()])
    .transform((value) => value || 'text'),
});

/*
 * Keep options permissive because the Next.js app stores options as JSON.
 * Different generated projects may contain different option fields.
 */
const optionsSchema = z
  .record(z.string(), z.unknown())
  .nullish()
  .transform((value) => value ?? {});

const compileRequestSchema = z.object({
  projectId: z.string().min(1).max(150),

  files: z
    .array(fileSchema)
    .min(1)
    .max(env.MAX_FILES),

  options: optionsSchema,

  spec: z.unknown().optional(),
});

type CompileRequest = z.infer<typeof compileRequestSchema>;

/*
|--------------------------------------------------------------------------
| Application setup
|--------------------------------------------------------------------------
*/

const app = express();

app.disable('x-powered-by');

app.use(helmet());

app.use(
  express.json({
    limit: '4mb',
  })
);

const buildLimiter = pLimit(env.MAX_CONCURRENT_BUILDS);

const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function timingSafeStringEqual(
  first: string,
  second: string
): boolean {
  if (first.length !== second.length) {
    return false;
  }

  let result = 0;

  for (let index = 0; index < first.length; index += 1) {
    result |=
      first.charCodeAt(index) ^
      second.charCodeAt(index);
  }

  return result === 0;
}

function requireWorkerSecret(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const authorization = req.header('authorization') || '';

  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : '';

  if (
    !token ||
    !timingSafeStringEqual(token, env.WORKER_SECRET)
  ) {
    console.error('[worker] Unauthorized compile request');

    res.status(401).json({
      success: false,
      error: 'Unauthorized worker request',
    });

    return;
  }

  next();
}

function readOption(
  options: Record<string, unknown>,
  name: string,
  fallback: string
): string {
  const value = options[name];

  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return fallback;
  }

  return String(value);
}

function safeRelativePath(input: string): string {
  const normalized = input
    .replaceAll('\\', '/')
    .replace(/^\/+/, '');

  const parts = normalized.split('/');

  if (
    !normalized ||
    normalized.includes('\0') ||
    parts.some(
      (part) =>
        part === '..' ||
        part === ''
    )
  ) {
    throw new Error(`Unsafe file path: ${input}`);
  }

  return normalized;
}

function sanitizeArtifactName(input: string): string {
  const sanitized = input
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return sanitized || 'NovxPlugin';
}

function normalizeMinecraftVersion(input: string): string {
  const match = input.match(/\d+\.\d+(?:\.\d+)?/);

  return match?.[0] || '1.21.1';
}

function normalizeJavaVersion(input: string): string {
  const normalized = input.replace(/[^\d]/g, '');

  if (normalized === '17') {
    return '17';
  }

  return '21';
}

function paperApiVersion(
  minecraftVersion: string
): string {
  return `${minecraftVersion}-R0.1-SNAPSHOT`;
}

/*
|--------------------------------------------------------------------------
| Trusted Maven configuration
|--------------------------------------------------------------------------
|
| The worker ignores AI-generated pom.xml files.
| This prevents generated projects from controlling Maven plugins,
| repositories, scripts, or build commands.
*/

function createTrustedPom(
  pluginName: string,
  minecraftVersion: string,
  javaVersion: string
): string {
  const safePluginName =
    sanitizeArtifactName(pluginName);

  const artifactId =
    safePluginName.toLowerCase();

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
      <version>${paperApiVersion(minecraftVersion)}</version>
      <scope>provided</scope>
    </dependency>
  </dependencies>

  <build>
    <finalName>${safePluginName}</finalName>

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

/*
|--------------------------------------------------------------------------
| Write generated project to temporary directory
|--------------------------------------------------------------------------
*/

async function writeTrustedProject(
  rootDirectory: string,
  request: CompileRequest
): Promise<void> {
  const totalBytes = request.files.reduce(
    (total, file) =>
      total +
      Buffer.byteLength(file.content, 'utf8'),
    0
  );

  if (totalBytes > env.MAX_TOTAL_SOURCE_BYTES) {
    throw new Error(
      `Project exceeds the ${env.MAX_TOTAL_SOURCE_BYTES}-byte source limit`
    );
  }

  for (const file of request.files) {
    const relativePath =
      safeRelativePath(file.path);

    /*
     * Ignore generated Maven files.
     * The worker creates a safe pom.xml itself.
     */
    if (
      relativePath === 'pom.xml' ||
      relativePath.startsWith('.mvn/') ||
      relativePath === 'mvnw' ||
      relativePath === 'mvnw.cmd'
    ) {
      continue;
    }

    const targetPath = path.join(
      rootDirectory,
      relativePath
    );

    const resolvedTarget =
      path.resolve(targetPath);

    const resolvedRoot =
      `${path.resolve(rootDirectory)}${path.sep}`;

    if (!resolvedTarget.startsWith(resolvedRoot)) {
      throw new Error(
        `File escaped build directory: ${relativePath}`
      );
    }

    await fs.mkdir(path.dirname(targetPath), {
      recursive: true,
    });

    await fs.writeFile(
      targetPath,
      file.content,
      'utf8'
    );
  }

  const pluginName = readOption(
    request.options,
    'pluginName',
    'NovxPlugin'
  );

  const rawMinecraftVersion = readOption(
    request.options,
    'mcVersion',
    '1.21.1'
  );

  const rawJavaVersion = readOption(
    request.options,
    'javaVersion',
    '21'
  );

  const minecraftVersion =
    normalizeMinecraftVersion(rawMinecraftVersion);

  const javaVersion =
    normalizeJavaVersion(rawJavaVersion);

  const pom = createTrustedPom(
    pluginName,
    minecraftVersion,
    javaVersion
  );

  await fs.writeFile(
    path.join(rootDirectory, 'pom.xml'),
    pom,
    'utf8'
  );
}

/*
|--------------------------------------------------------------------------
| Run Maven
|--------------------------------------------------------------------------
*/

async function runCommand(
  command: string,
  args: string[],
  workingDirectory: string,
  timeoutMs: number
): Promise<{
  code: number;
  logs: string;
}> {
  return await new Promise(
    (resolve, reject) => {
      const child = spawn(command, args, {
        cwd: workingDirectory,
        shell: false,
        windowsHide: true,

        env: {
          PATH: process.env.PATH || '',
          HOME: process.env.HOME || '/tmp',

          MAVEN_OPTS:
            '-Xms64m -Xmx768m -XX:MaxMetaspaceSize=256m',
        },

        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
      });

      let logs = '';

      const maximumLogCharacters = 500_000;

      const appendLogs = (chunk: Buffer) => {
        if (
          logs.length <
          maximumLogCharacters
        ) {
          logs += chunk
            .toString('utf8')
            .slice(
              0,
              maximumLogCharacters -
                logs.length
            );
        }
      };

      child.stdout.on('data', appendLogs);
      child.stderr.on('data', appendLogs);

      child.on('error', reject);

      const timer = setTimeout(() => {
        child.kill('SIGKILL');

        reject(
          new Error(
            `Build timed out after ${timeoutMs}ms\n${logs}`
          )
        );
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);

        resolve({
          code: code ?? 1,
          logs,
        });
      });
    }
  );
}

/*
|--------------------------------------------------------------------------
| ZIP creation
|--------------------------------------------------------------------------
*/

async function createSourceZip(
  sourceDirectory: string,
  outputPath: string
): Promise<void> {
  await new Promise<void>(
    (resolve, reject) => {
      const output =
        createWriteStream(outputPath);

      const archive = archiver('zip', {
        zlib: {
          level: 9,
        },
      });

      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);

      archive.pipe(output);

      archive.glob('**/*', {
        cwd: sourceDirectory,
        ignore: [
          'target/**',
        ],
        dot: true,
      });

      void archive.finalize();
    }
  );
}

/*
|--------------------------------------------------------------------------
| Supabase Storage upload
|--------------------------------------------------------------------------
*/

async function uploadArtifact(
  localPath: string,
  remotePath: string,
  contentType: string
): Promise<void> {
  const fileBytes =
    await fs.readFile(localPath);

  const { error } = await supabase.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .upload(remotePath, fileBytes, {
      contentType,
      upsert: true,
    });

  if (error) {
    throw new Error(
      `Supabase upload failed: ${error.message}`
    );
  }
}

/*
|--------------------------------------------------------------------------
| Health endpoint
|--------------------------------------------------------------------------
*/

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'novx-worker',
    java: 21,
    concurrentBuilds:
      env.MAX_CONCURRENT_BUILDS,
  });
});

/*
|--------------------------------------------------------------------------
| Compile endpoint
|--------------------------------------------------------------------------
*/

app.post(
  '/compile',
  requireWorkerSecret,
  async (req, res) => {
    console.log(
      '[worker] Compile request received'
    );

    const parsed =
      compileRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      console.error(
        '[worker] Invalid compile request:',
        JSON.stringify(
          parsed.error.issues,
          null,
          2
        )
      );

      res.status(400).json({
        success: false,
        error: 'Invalid compile request',
        logs: JSON.stringify(
          parsed.error.issues,
          null,
          2
        ),
        details: parsed.error.issues,
        attempts: 1,
      });

      return;
    }

    try {
      const result = await buildLimiter(
        async () => {
          const request = parsed.data;

          const buildId = randomUUID();

          const temporaryDirectory =
            await fs.mkdtemp(
              path.join(
                os.tmpdir(),
                'novx-build-'
              )
            );

          console.log(
            `[worker] Build ${buildId} started for project ${request.projectId}`
          );

          try {
            await writeTrustedProject(
              temporaryDirectory,
              request
            );

            const buildResult =
              await runCommand(
                'mvn',
                [
                  '--batch-mode',
                  '--no-transfer-progress',
                  'clean',
                  'package',
                ],
                temporaryDirectory,
                env.BUILD_TIMEOUT_MS
              );

            console.log(
              `[worker] Maven exited with code ${buildResult.code}`
            );

            if (buildResult.code !== 0) {
              return {
                success: false,
                error:
                  'Maven compilation failed',
                logs: buildResult.logs,
                attempts: 1,
              };
            }

            const targetDirectory =
              path.join(
                temporaryDirectory,
                'target'
              );

            const targetEntries =
              await fs.readdir(
                targetDirectory
              );

            const jarName =
              targetEntries.find(
                (entry) =>
                  entry.endsWith('.jar') &&
                  !entry.endsWith(
                    '-sources.jar'
                  ) &&
                  !entry.startsWith(
                    'original-'
                  )
              );

            if (!jarName) {
              return {
                success: false,
                error:
                  'Maven completed but did not produce a JAR file',
                logs: buildResult.logs,
                attempts: 1,
              };
            }

            const pluginName =
              sanitizeArtifactName(
                readOption(
                  request.options,
                  'pluginName',
                  'NovxPlugin'
                )
              );

            const sourceZipPath =
              path.join(
                temporaryDirectory,
                `${pluginName}-source.zip`
              );

            await createSourceZip(
              temporaryDirectory,
              sourceZipPath
            );

            const remoteBase =
              `builds/${request.projectId}/${buildId}`;

            const jarRemotePath =
              `${remoteBase}/${pluginName}.jar`;

            const zipRemotePath =
              `${remoteBase}/${pluginName}-source.zip`;

            console.log(
              `[worker] Uploading JAR to ${jarRemotePath}`
            );

            await uploadArtifact(
              path.join(
                targetDirectory,
                jarName
              ),
              jarRemotePath,
              'application/java-archive'
            );

            console.log(
              `[worker] Uploading ZIP to ${zipRemotePath}`
            );

            await uploadArtifact(
              sourceZipPath,
              zipRemotePath,
              'application/zip'
            );

            console.log(
              `[worker] Build ${buildId} completed successfully`
            );

            return {
              success: true,
              logs: buildResult.logs,
              jarPath: jarRemotePath,
              zipPath: zipRemotePath,
              attempts: 1,
            };
          } finally {
            await fs.rm(
              temporaryDirectory,
              {
                recursive: true,
                force: true,
              }
            );
          }
        }
      );

      res
        .status(result.success ? 200 : 422)
        .json(result);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown worker failure';

      console.error(
        '[worker] Build failed:',
        error
      );

      res.status(500).json({
        success: false,
        error: message,
        logs: message,
        attempts: 1,
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Unknown routes
|--------------------------------------------------------------------------
*/

app.use((_req, res) => {
  res.status(404).json({
    error: 'Not found',
  });
});

/*
|--------------------------------------------------------------------------
| Start server
|--------------------------------------------------------------------------
*/

app.listen(
  env.PORT,
  '0.0.0.0',
  () => {
    console.log(
      `NOVX worker listening on port ${env.PORT}`
    );
  }
);