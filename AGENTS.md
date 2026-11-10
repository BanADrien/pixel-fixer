# Exemple : bloc a copier dans le AGENTS.md (ou CLAUDE.md) du projet de jeu

---

## Images pixel art : passage obligatoire dans l'outil "unslop pixelart"

Apres avoir genere ou enregistre une image de sprite, tuile ou icone (PNG, JPG, WEBP) :

1. Lancer, depuis la racine du projet :

       node "M:/Adrien/perso/unslop pixelart/cli.js" "<chemin/vers/image.png>" --in-place

   ou, pour ecrire dans le dossier des assets propres sans toucher la source :

       node "M:/Adrien/perso/unslop pixelart/cli.js" "<chemin/vers/image.png>" --out "<dossier des assets>"

2. Verifier le code de sortie : 0 = ok ; 1 = image en echec (lire la ligne affichee, regenerer ou corriger, relancer) ; 2 = erreur de commande.
3. Ne pas passer de taille ni de palette a la main : elles viennent de `unslop.config.json` a la racine du projet (palette du projet, hauteur par dossier). Ne pas le modifier sans accord.
4. Pour un lot : ajouter `--json` et lire le resume (une entree par image : fichier, grille detectee ou taille de conversion, nombre de couleurs, ok).
5. En mode `--in-place`, l'original est garde dans `_originals/` a cote ; ne pas le supprimer.

---
