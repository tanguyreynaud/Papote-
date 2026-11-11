// Avant les essais du parcours de Mamie : tout ce que prépare l'app famille (fonctions de main, règles, navigateur),
// puis la tablette de sa branche (code Java et écrans) dans .tablette/, compilée pour tourner sur l'ordinateur.
//   PAPOTE_TABLETTE=<dossier du dépôt>   pour prendre la tablette d'un dossier (au lieu de la branche en ligne)
//   PAPOTE_BRANCHE_TABLETTE=<branche>    autre branche que claude/project-thread-cmnwxy

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ici = __dirname;
const racine = path.join(ici, '..', '..');
const BRANCHE = process.env.PAPOTE_BRANCHE_TABLETTE || 'claude/project-thread-cmnwxy';
const run = (cmd, cwd = racine) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

// Fonctions de main, règles et navigateur : le préparateur de l'app famille (même dossier .fonctions/ et .regles/).
if (!fs.existsSync(path.join(ici, '..', 'app-famille', 'node_modules'))) {
  execSync('npm ci --no-audit --no-fund', { cwd: path.join(ici, '..', 'app-famille'), stdio: 'inherit' });
}
execSync('node preparer.js', { cwd: path.join(ici, '..', 'app-famille'), stdio: 'inherit' });

function tablette() {
  const dossier = path.join(ici, '.tablette');
  const marque = path.join(dossier, 'SHA');
  const jvm = path.join(ici, 'tablette-jvm');
  let sources;
  let sha;
  if (process.env.PAPOTE_TABLETTE) {
    sources = path.resolve(process.env.PAPOTE_TABLETTE);
    sha = `dossier ${sources}`;
    console.log(`Tablette : ${sources}`);
  } else {
    try { run(`git fetch --quiet origin ${BRANCHE}`); } catch (e) { console.warn('Pas de réseau pour lire la branche de la tablette : version déjà préparée gardée.'); }
    sha = run(`git rev-parse origin/${BRANCHE}`);
    sources = dossier;
    if (!(fs.existsSync(marque) && fs.readFileSync(marque, 'utf8').trim() === sha)) {
      console.log(`Tablette ${sha.slice(0, 7)} : extraction…`);
      fs.rmSync(dossier, { recursive: true, force: true });
      fs.mkdirSync(dossier, { recursive: true });
      run(`git archive --format=tar -o "${path.join(dossier, 't.tar')}" ${sha} android/app/src/main android/tests/banc.js`);
      run('tar -xf t.tar', dossier);
      fs.rmSync(path.join(dossier, 't.tar'));
      fs.rmSync(path.join(jvm, 'target'), { recursive: true, force: true });
    } else console.log(`Tablette ${sha.slice(0, 7)} déjà extraite.`);
  }
  // Compilation (Java 17 ou plus, Maven) : le code de l'appli tel quel + le peu d'Android imité.
  const java = path.join(sources, 'android', 'app', 'src', 'main', 'java');
  console.log('Tablette : compilation du code Java…');
  execSync(`mvn -q -B compile "-Dtablette.sources=${java}"`, { cwd: jvm, stdio: 'inherit' });
  const m2 = path.join(os.homedir(), '.m2', 'repository');
  const pom = fs.readFileSync(path.join(jvm, 'pom.xml'), 'utf8');
  const androidAll = /<android.all>([^<]+)</.exec(pom)[1];
  const zxing = /<artifactId>core<\/artifactId>\s*<version>([^<]+)</.exec(pom)[1];
  const jars = [
    path.join(m2, 'org', 'robolectric', 'android-all', androidAll, `android-all-${androidAll}.jar`),
    path.join(m2, 'com', 'google', 'zxing', 'core', zxing, `core-${zxing}.jar`),
  ];
  for (const j of jars) if (!fs.existsSync(j)) throw new Error(`Bibliothèque absente après la compilation : ${j}`);
  fs.mkdirSync(dossier, { recursive: true });
  fs.writeFileSync(path.join(dossier, 'pret.json'), JSON.stringify({
    sha, sources,
    assets: path.join(sources, 'android', 'app', 'src', 'main', 'assets'),
    banc: path.join(sources, 'android', 'tests', 'banc.js'),
    classpath: [path.join(jvm, 'target', 'classes'), ...jars].join(path.delimiter),
  }, null, 2));
  if (!process.env.PAPOTE_TABLETTE) fs.writeFileSync(marque, sha);
}

tablette();
