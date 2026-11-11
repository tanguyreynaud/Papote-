package com.google.android.gms.tasks;
public class Task<T> {
  public Task<T> addOnCompleteListener(OnCompleteListener<T> l) { return this; }
  public Task<T> addOnSuccessListener(OnSuccessListener<? super T> l) { return this; }
  public Task<T> addOnFailureListener(OnFailureListener l) { return this; }
  public boolean isSuccessful() { return false; } public T getResult() { return null; } public Exception getException() { return null; }
}
