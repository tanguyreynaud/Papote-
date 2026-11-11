package com.google.firebase.messaging;
import com.google.android.gms.tasks.Task;
public class FirebaseMessaging { public static FirebaseMessaging getInstance() { return new FirebaseMessaging(); } public Task<String> getToken() { return new Task<>(); } public Task<Void> subscribeToTopic(String t) { return new Task<>(); } }
