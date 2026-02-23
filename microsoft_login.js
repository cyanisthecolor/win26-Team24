import { PublicClientApplication } from "@azure/msal-browser";

const msalConfig = {
    auth: {
        clientId: "fde8d6d4-cb6f-4ad5-862f-0ab740a0bec8", 
        authority: "https://login.microsoftonline.com/common",
        redirectUri: "http://localhost:3000",
    }
};

const msalInstance = new PublicClientApplication(msalConfig);
await msalInstance.initialize();

const loginRequest = {
    scopes: ["User.Read", "Mail.ReadWrite", "Mail.Send"] 
};

async function signIn() {
    try {
        const loginResponse = await msalInstance.loginPopup(loginRequest);
        console.log("Sign in successful!", loginResponse.account);
        console.log("Access Token:", loginResponse.accessToken);
        
    } catch (error) {
        console.error("Error during sign in:", error);
    }
}