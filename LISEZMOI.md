# Pixel Clean (unslop pixelart)

Refait n'importe quelle image en vrai pixel art, par algorithme (pas d'IA) : faux pixel art genere par IA (pixels irreguliers, grille qui derive, bords flous, couleurs proches, artefacts, faux damier) ou image pas du tout pixelisee (illustration, rendu lisse).

## Ouvrir

- Double-cliquer sur `index.html` (Chrome), puis glisser-deposer des images ou un dossier. Le traitement demarre tout seul.
- Clic sur une vignette : vue detaillee (original en petit, resultat qui se construit en grand ; Espace pour passer l'animation).
- Les fichiers d'origine ne sont jamais modifies. Export : `.zip` ou "Enregistrer dans un dossier" (sous-dossier `pixel-clean/`, PNG x1 + version xN + `palette.hex`).

## Taille finale (en haut des reglages)

- Fixe (par defaut) : hauteur en px (32), largeur facultative ; toutes les images sortent a cette taille, le sujet tient dans hauteur x largeur. Info "taille fixe -> 32 px".
- Auto : la grille de pixels detectee (meme irreguliere) donne la taille ; sans grille (image lisse), la hauteur indiquee. Info "grille detectee : 8,3 px -> 37 px".

## Reglages cles

- Couleurs (auto ou N), palette commune au lot (cochee : coherence du jeu), palette imposee (.hex, .gpl, PNG Lospec).
- Fond : rendu transparent automatiquement (fond uni ou faux damier), ou garde.
- Embellir (decoche par defaut) : "Contour propre" (contour exterieur 1 px, sans trou) et "Lignes pixel-perfect" (supprime les doublons en escalier).

## Si le resultat est rate

Ouvrir l'image, "Corriger cette image" : changer sa taille finale (Auto / Fixe, hauteur, largeur), ou regler la taille de pixel a la main (mesurer un "pixel" sur l'original, ex. 8,3) et au besoin le decalage X/Y ; cocher "Grille" pour voir les cellules.

## Ligne de commande (meme algorithme)

Une fois : `npm install` dans ce dossier (Node 18+).

    node cli.js <fichier|dossier> [--out dossier] [--height 32|auto] [--width 24] [--colors 16] [--palette p.hex] [--outline darkest|selective] [--pixel-perfect] [--scale 4] [--json]
    node cli.js <dossier> --in-place        (remplace, originaux gardes dans _originals/)
    node cli.js make-palette <dossier> --colors 24 --out palette.hex
    node cli.js --watch <dossier>           (traite chaque nouvelle image)

Code de sortie : 0 ok, 1 image en echec, 2 erreur d'usage.

## Brancher sur un projet

- Copier `unslop.config.example.json` a la racine du jeu sous le nom `unslop.config.json` : palette du projet, taille par defaut, regles par sous-dossier (`characters/**` hauteur 32, `tiles/**` 16, `"height": "auto"`, `width`...). Il est cherche dans le dossier courant puis les parents.
- Une palette fixe (`make-palette` sur les sprites existants) garde le jeu coherent quand les images arrivent une par une.
- `AGENTS.md` : bloc a copier pour que l'agent de code passe chaque image generee dans l'outil.

## Vue connectee au dossier assets

    node cli.js serve --config "<jeu>/unslop.config.json"

Ouvre `http://127.0.0.1:4870/` : dossiers `source` (images brutes) et `output` (sprites propres) de la config, statuts par image (Manquant, En cours, Fait, A revoir, Valide, Erreur, Obsolete) mis a jour en direct, boutons traiter les manquants / retraiter / valider. Serveur local uniquement ; il n'ecrit que dans `output`.

## Tests

`npm test` : algorithme, ligne de commande, serveur (API et securite).
