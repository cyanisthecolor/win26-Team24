import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Button, Text, View } from 'react-native';

WebBrowser.maybeCompleteAuthSession();

const discovery = {
  authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
};

export default function App() {
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: 'fde8d6d4-cb6f-4ad5-862f-0ab740a0bec8',
      scopes: ['openid', 'profile', 'email', 'User.Read'],
      redirectUri: AuthSession.makeRedirectUri({
        scheme: 'team24app',
      }),
    },
    discovery
  );

  // Check if we are logged in
  const isLoggedIn = response?.type === 'success';

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      {isLoggedIn ? (
        <Text style={{ fontSize: 24 }}>pasta</Text>
      ) : (
        <Button
          disabled={!request}
          title="Login with Microsoft"
          onPress={() => {
            promptAsync();
          }}
        />
      )}
    </View>
  );
}