package com.papote.tablette;

import android.app.admin.DevicePolicyManager;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/**
 * Recherche de mise à jour indépendante de l'écran (audit du 11/11, T-A) : deux fois par jour, Android
 * lance cette tâche même si l'écran de Papote n'a jamais réussi à s'ouvrir. Tant que l'écran va bien, elle
 * ne fait rien : c'est lui qui cherche les mises à jour (au démarrage, à l'annonce, une fois par jour),
 * et la tâche n'ajoute ni téléchargement ni relance en journée.
 */
public class MajTache extends JobService {
    private static final int ID = 4711;

    /** À appeler au démarrage de la tablette et à l'ouverture de Papote : sans effet si déjà planifiée. */
    static void planifier(Context c) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null || js.getPendingJob(ID) != null) return;
            js.schedule(new JobInfo.Builder(ID, new ComponentName(c, MajTache.class))
                    .setPeriodic(12 * 3600_000L)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPersisted(true)
                    .build());
        } catch (Exception e) {
            android.util.Log.w("Papote", "Tâche de mise à jour", e);
        }
    }

    /** La tâche doit-elle chercher une mise à jour ? Seulement si l'écran n'est pas ouvert ou n'a pas tenu une minute. */
    static boolean utile(boolean ecranOuvert, boolean enDifficulte) {
        return !ecranOuvert || enDifficulte;
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        final Context app = getApplicationContext();
        if (!utile(MainActivity.ouverte(), Secours.enDifficulte(app))) return false;
        new Thread(() -> {
            try {
                DevicePolicyManager dpm = (DevicePolicyManager) app.getSystemService(Context.DEVICE_POLICY_SERVICE);
                if (dpm != null && dpm.isDeviceOwnerApp(app.getPackageName())) {
                    Journal.log(app, "Mise à jour cherchée par la tâche de fond (écran absent ou en difficulté)");
                    Updater.check(app);
                }
            } catch (Throwable e) {
                android.util.Log.w("Papote", "Tâche de mise à jour", e);
            } finally {
                jobFinished(params, false);
            }
        }, "papote-maj-tache").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }
}
