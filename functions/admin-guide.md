# Guide « Que faire si… » de l'admin Papote

Même texte que la page #aide de l'admin (web/admin.html, section « aide ») : 6 cas, 3 étapes chacun.
Chaque lien entre parenthèses est un écran de l'admin (#…) ou un site extérieur. Garder les deux à jour ensemble.

## Tablette perdue ou volée

1. Coupez-la à distance. Ouvrez la tablette dans le stock, puis « Tablette volée : tout couper » (il faut retaper son n° de série) : elle se verrouille (ou s'efface), sort de sa famille (plus aucune photo ni message), ses comptes sont désactivés et sa fiche passe « Perdue ». Si elle est éteinte, elle se verrouille dès qu'elle se reconnecte. Lien : [Ouvrir les tablettes](#stock/tablettes)
2. Envoyez-en une autre, sur le même écran. « Envoyer une tablette de remplacement » prélève d'abord 140 € (150 € si une enceinte a été fournie, prévu aux CGV) ; seulement si c'est payé, la tablette et la carte SIM (case cochée) sont remplacées et l'étiquette d'envoi est faite. Refusé : rien ne part, la famille reçoit un e-mail. Stock vide : « Acheter une tablette de remplacement » ; elle reste dans « À faire » jusqu'à son envoi. Lien : [Ouvrir les tablettes](#stock/tablettes)
3. Résiliez l'ancienne carte SIM. Elle passe « suspendue » : résiliez-la aussi chez l'opérateur. Si la tablette réapparaît : sur sa page, ⋮ « Retrouvée », puis réinstallez-la. Lien : [Ouvrir les cartes SIM](#stock/sim)

## Paiement refusé (prélèvement SEPA ou carte)

1. Repérez la famille. L'accueil l'affiche dans « À faire » : « en retard de paiement », avec la date de mise en pause. Pendant 7 jours, tout marche encore ; ensuite la tablette affiche « Papote est en pause ». Lien : [Ouvrir l'accueil](#accueil)
2. Appelez la famille. Elle met à jour sa carte ou son compte dans l'appli famille : Réglages, page Abonnement, « Carte bancaire et factures ». Tout repart dès que le paiement passe. Son numéro est dans la liste des clients. Lien : [Ouvrir les clients](#clients/liste)
3. Toujours rien ? Regardez le paiement dans Stripe (refus, contestation). Après 30 jours de pause, l'accueil vous propose de demander le retour de la tablette (« Arrêter l'abonnement » sur la commande). Liens : [Ouvrir Stripe](https://dashboard.stripe.com), [Voir les factures](#compta/factures)

## Mamie à l'hôpital (absence longue)

1. Demandez un justificatif. Un bulletin d'hospitalisation, envoyé par la famille (e-mail ou photo).
2. Mettez en pause. Sur la commande, menu ⋮ « Pause hospitalisation… », puis la date de reprise. Plus aucun prélèvement ni alerte « ne répond plus » jusque-là ; la famille reçoit un e-mail. La tablette continue de marcher. Le menu ne la propose qu'après les 30 premiers jours de l'abonnement : avant, appelez la famille. Lien : [Ouvrir les commandes](#commandes)
3. Au retour. À la date choisie, les prélèvements reprennent seuls. Retour plus tôt : menu ⋮ « Reprendre les prélèvements » sur la commande. Lien : [Ouvrir les commandes](#commandes)

## Panne Firebase ou Google (le service ne répond plus)

1. Vérifiez que la panne vient de Google. La page d'état de Firebase dit si un service est en panne et depuis quand. Si l'admin elle-même ne s'ouvre plus, c'est sans doute ça. Lien : [État de Firebase](https://status.firebase.google.com)
2. Ne touchez à rien. Pas de remise à zéro des tablettes pendant la panne. Si elle dure, prévenez les familles par téléphone ou depuis votre propre messagerie (l'e-mail d'information de l'admin passe lui aussi par Google).
3. Une fois revenu. Regardez l'accueil, puis la page de chaque tablette : « En ligne » doit redevenir récent. Une tablette toujours muette : « Redémarrer ». Liens : [Ouvrir l'accueil](#accueil), [Ouvrir les tablettes](#stock/tablettes)

## Carte SIM sans données ou forfait épuisé

1. Regardez la carte SIM. Sur sa page : « Fin du forfait » et « Data du mois » disent si le forfait est fini ou plein. Une ligne « suspendue » se réactive chez l'opérateur. Lien : [Ouvrir les cartes SIM](#stock/sim)
2. Rechargez chez l'opérateur, puis touchez « J'ai rechargé » sur la page de la carte : la dépense et la nouvelle fin du forfait sont notées. Lien : [Ouvrir les cartes SIM](#stock/sim)
3. Vérifiez la tablette. Sur sa page, « État complet maintenant » : la carte SIM et internet doivent revenir. Sinon, « Redémarrer ». Lien : [Ouvrir les tablettes](#stock/tablettes)

## Tablette cassée

1. Trouvez une tablette de rechange. Il en faut une « En stock » dans la liste des tablettes. Lien : [Ouvrir les tablettes](#stock/tablettes)
2. Remplacez-la. Sur la commande du client, menu ⋮ « Remplacer un élément du kit (cassé ou perdu)… », « la tablette », avec le motif (ex. écran cassé). L'étiquette d'envoi s'ouvre ; celle du retour part au client par e-mail. Sa carte SIM passe dans la nouvelle tablette. Vous pouvez aussi faire l'échange en main propre. Lien : [Ouvrir les commandes](#commandes)
3. Quand l'ancienne revient. L'accueil la suit (« remplacée, à récupérer »). Une fois revenue, sur sa page : menu ⋮ « Mettre à réparer », ou « Déclarer hors service » si elle est fichue. Lien : [Ouvrir les tablettes](#stock/tablettes)

## Autres écrans utiles

- Le guide lui-même : [Que faire si…](#aide)
- Une tablette précise : sa page #tablette/<id> (« En ligne », batterie, carte SIM, boutons « Redémarrer » et « État complet maintenant »).
- Une carte SIM précise : sa page #sim/<id> (« Fin du forfait », « Data du mois », « J'ai rechargé »).
- Une commande précise : sa page #commande/<id> (menu ⋮ : remplacer, pause hospitalisation, arrêter l'abonnement).
