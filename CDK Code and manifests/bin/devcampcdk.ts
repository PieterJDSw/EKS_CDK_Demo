#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DevcampcdkStack } from '../lib/devcampcdk-stack';


const id = "137065650613"
const region = "af-south-1"
const app = new cdk.App();
new DevcampcdkStack(app, 'clusterStac', {
  env: {region: region,account:id},
  devopsStack: false,
  infrastack: true
});
new DevcampcdkStack(app, 'notifyStac', {
  env: {region: region,account:id},
  devopsStack: false,
  infrastack: false,
  notifyStack:true
});
// new DevcampcdkStack(app, 'DevopsStack', {
//   env: {region: region,account:id},
//   devopsStack: true,
//   infrastack: false
// });
// new DevcampcdkStack(app, 'manageStack', {
//   env: {region: region,account:id},
//   devopsStack: false,
//   infrastack: false,
//   manageStack:true
// });


app.synth();