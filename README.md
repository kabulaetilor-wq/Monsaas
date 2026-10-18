# MonSaaS — un SaaS d'exemple connecté à SaaS H

Une petite application SaaS (Node.js 18+, **aucune dépendance**) qui montre toute la connexion avec SaaS H.

## Ce que fait MonSaaS
| Côté MonSaaS | Ce qui se passe dans SaaS H |
|---|---|
| Un utilisateur clique « Demander l'accès » | La demande apparaît dans **Demandes** (+ notification). Vous l'acceptez : MonSaaS reçoit la décision (rappel signé) et **accorde l'accès** |
| Un utilisateur se déconnecte | La durée de session arrive dans **Équipe et usage** |
| `GET /health` toutes les minutes | État, latence, disponibilité, pannes |
| Admin : « Simuler une panne » | `/health` répond 503 → panne détectée + alerte ; fin de panne → alerte de rétablissement |
| Boutons de SaaS H | MonSaaS exécute : redémarrer, déployer, sauvegarder, vider le cache, rapport, inviter, révoquer, exporter |
| Interrupteur « maintenance » de SaaS H | MonSaaS passe en maintenance (et inversement) |

## Lancer en local
```
cd monsaas
ADMIN_EMAIL=vous@exemple.com node server.js     # ouvrez http://localhost:3000
node test.js                                    # 38 tests contre un faux SaaS H
```
Créez d'abord un compte avec l'email `ADMIN_EMAIL` : il devient administrateur.

## Déployer (sans PC)
Ce dépôt contient son propre `render.yaml` (indépendant du dépôt SaaS H).
Sans carte bancaire : dans Render, *New + → **Web Service*** (pas Blueprint, qui demande une carte) → votre dépôt → Runtime **Node**, Build `npm install`, Start `node server.js`, Instance **Free**, health check `/health`. Renseignez ensuite les variables de `monsaas-demo`.

| Variable | Valeur |
|---|---|
| `API_TOKEN` | Généré par Render. **À recopier** dans SaaS H (étape 1) |
| `ADMIN_EMAIL` | Votre email |
| `SAASH_WEBHOOK_URL` | Lien « Copier webhook » du connecteur (étape 2) |
| `SAASH_URL` | Adresse https de l'API SaaS H |
| `SAASH_API_KEY` | Clé API : Plus → Intégration (étape 3) |
| `SAASH_MAINT_CODE` | (optionnel) code de l'interrupteur maintenance, `maintenance` par défaut |

## Brancher MonSaaS dans l'app SaaS H
1. **Services → + → Connecteur personnalisé** : nom `MonSaaS`, URL de base `https://monsaas-demo.onrender.com`,
   chemin de santé `/health`, en-tête d'authentification **vide**, clé = la valeur de `API_TOKEN`.
2. Sur la carte du connecteur : **Copier webhook** → collez-le dans `SAASH_WEBHOOK_URL` côté MonSaaS.
3. **Plus → Intégration** : copiez la **clé API** dans `SAASH_API_KEY`, et définissez l'**URL de rappel** :
   `https://monsaas-demo.onrender.com/saash/callback`. Renseignez aussi `SAASH_URL`. Redéployez MonSaaS.
4. **Plus → Boutons et interrupteurs** : créez des boutons sur le connecteur `MonSaaS`
   (types *Redémarrer*, *Déployer*, *Sauvegarder*, *Vider le cache*, *Envoyer un rapport*, *Exporter*…) :
   les chemins par défaut correspondent déjà à MonSaaS. Pour *Inviter* / *Révoquer*, modifiez l'email dans le corps JSON.
5. **Interrupteur** : code `maintenance`, SaaS `MonSaaS`, méthode `POST`, chemin `/maintenance`,
   corps `{"enabled":{{state}}}`.

## Essayer
1. Sur MonSaaS : créez un compte utilisateur → *Demander l'accès*.
2. Sur le téléphone : onglet **Demandes** → **Accepter**.
3. Sur MonSaaS : *Actualiser* → *Accès accordé ✓* → *Ouvrir l'espace premium*.
4. Administrateur de MonSaaS : *Simuler une panne* → l'onglet **Pannes** de SaaS H s'ouvre sur un incident.
5. Basculez l'interrupteur *maintenance* dans SaaS H → MonSaaS affiche le bandeau de maintenance.

## API de gestion (appelée par SaaS H, `Authorization: Bearer <API_TOKEN>`)
`POST /restart` · `/deploy` · `/backup` · `/cache/clear` · `/maintenance {"enabled":true}` · `/reports/send` ·
`/users/invite {"email"}` · `/access/revoke {"email"}` · `GET /export`

## Sécurité intégrée
Mots de passe hachés (scrypt), sessions en cookie HttpOnly, limite d'essais de connexion, rappels SaaS H vérifiés
par signature HMAC avec protection contre le rejeu, jeton de gestion comparé en temps constant, JSON obligatoire
sur l'API (anti-CSRF), aucun HTML injecté dans l'interface, `/export` sans aucun mot de passe.

## Limites (c'est un exemple)
- Les données sont dans un fichier JSON : sur l'offre gratuite de Render, elles peuvent être perdues à un redémarrage.
  Pour un vrai SaaS, utilisez une base de données.
- Le serveur gratuit s'endort : le premier chargement peut prendre une minute.
- « Redémarrer », « Déployer » et « Sauvegarder » sont simulés (version, fichier de sauvegarde, sessions fermées).
- Si `API_TOKEN` n'est pas défini, un jeton temporaire est affiché dans les journaux : réservé à la démo.
