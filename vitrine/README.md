# Site vitrine Papote

Page de présentation publique (fonctionnement, tarifs, FAQ, contact). Fichiers statiques, sans dépendance : `index.html` et `icon.svg`.

## Déploiement prévu

Un second site Firebase Hosting dans le projet `papote-famille`, à côté de l'appli famille (dont l'adresse ne change pas).

1. Créer le site une fois : `firebase hosting:sites:create papote` (ou un autre nom libre, par exemple `papote-tablette`). Il sera servi sur `https://<nom>.web.app`.
2. Associer les cibles :
   ```
   firebase target:apply hosting famille papote-famille
   firebase target:apply hosting vitrine <nom>
   ```
3. Dans `firebase.json`, `hosting` devient une liste de deux entrées (voir ci-dessous).
4. Déployer le site seul : `firebase deploy --only hosting:vitrine`.

```json
"hosting": [
  {
    "target": "famille",
    "public": "web",
    "ignore": ["firebase.json", "**/.*"],
    "headers": [
      { "source": "**", "headers": [{ "key": "Cache-Control", "value": "no-cache" }] }
    ]
  },
  {
    "target": "vitrine",
    "public": "vitrine",
    "ignore": ["README.md", "**/.*"]
  }
]
```

Avec ce changement, `firebase deploy --only hosting` déploie les deux sites ; `--only hosting:famille` ne déploie que l'appli famille.
