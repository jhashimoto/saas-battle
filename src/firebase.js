import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyBg0jTQyymX0WAVRgH8dgOa0FtxLGrCBUM",
  authDomain: "saas-battle-3aef6.firebaseapp.com",
  databaseURL: "https://saas-battle-3aef6-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "saas-battle-3aef6",
  storageBucket: "saas-battle-3aef6.firebasestorage.app",
  messagingSenderId: "130956944819",
  appId: "1:130956944819:web:9cc6d98aaa0f9ff725d7c6"
};

export const db = getDatabase(initializeApp(firebaseConfig));
