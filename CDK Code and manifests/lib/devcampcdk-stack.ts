import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snssub from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as events from 'aws-cdk-lib/aws-events';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { SecretValue, aws_budgets as budgets } from 'aws-cdk-lib';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { SfnStateMachine } from 'aws-cdk-lib/aws-events-targets';
import * as stepfunctions  from 'aws-cdk-lib/aws-stepfunctions';
import * as logs  from 'aws-cdk-lib/aws-logs';
import * as s3  from 'aws-cdk-lib/aws-s3';
import * as tasks  from 'aws-cdk-lib/aws-stepfunctions-tasks';
const k8sLayer = require('@aws-cdk/lambda-layer-kubectl-v27');



interface DevcampcdkStackProps extends cdk.StackProps {
  devopsStack: boolean;
  infrastack: boolean;
  manageStack?: boolean;
  notifyStack?: boolean;
}

export class DevcampcdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: DevcampcdkStackProps) {
    super(scope, id, props);
  
    //Devops STACK
    if(props && props?.devopsStack ){
      
        const ferepository = new ecr.Repository(this, 'fe',{repositoryName:"fe"});
        
        ferepository.addLifecycleRule({ tagPrefixList: ['fe'], maxImageCount: 5 });
        ferepository.addLifecycleRule({ maxImageAge: cdk.Duration.days(30) });
        const berepository = new ecr.Repository(this, 'be',{repositoryName:"be"});
        berepository.addLifecycleRule({ tagPrefixList: ['be'], maxImageCount: 5 });
        berepository.addLifecycleRule({ maxImageAge: cdk.Duration.days(30) });
    }

    

      
    if(props && props?.notifyStack == true){
      

      const destinationBucket= new s3.Bucket(this, "DestinationBucket", {
        bucketName: "highriskbucketcamp",
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        versioned: true
     })

      const Q = new sqs.Queue(this, 'DeadLetterQueue',{queueName:'DeadQ'});
      const deadLetterQueue: sqs.DeadLetterQueue = {
        maxReceiveCount: 123,
        queue: Q,
      };
      const highRiskQ = new sqs.Queue(this, 'HighRiskrQueue',{
        deadLetterQueue: deadLetterQueue,
        queueName:'HighRiskQueue'
      });


      const topic = new sns.Topic(this, 'HighRisktopic', {
       
        displayName: 'HighRisktopic',
        
      });

      topic.addSubscription(new snssub.SqsSubscription(highRiskQ,{rawMessageDelivery:true}))

      const bus = new events.EventBus(this, 'bus', {
        eventBusName: 'RiskEventbus'
      });

      const pipeRole = new iam.Role(this, "PipeRole", {
        assumedBy: new ServicePrincipal("pipes.amazonaws.com", {}),
      });

      pipeRole.addToPrincipalPolicy(new iam.PolicyStatement({
                  resources: [highRiskQ.queueArn],
                  actions: [
                      "sqs:ReceiveMessage",
                      "sqs:DeleteMessage",
                      "sqs:GetQueueAttributes",
                  ],
                  effect: iam.Effect.ALLOW  }))


                        pipeRole.addToPrincipalPolicy(new iam.PolicyStatement({
                                  resources: [bus.eventBusArn],
                                  actions: ["events:PutEvents"],
                                  effect: iam.Effect.ALLOW }))
    
    
        // Create the pipe
        const pipe = new pipes.CfnPipe(this, "Pipe", {
            name: "risk-Pipe",
            roleArn: pipeRole.roleArn,
            source: highRiskQ.queueArn,
            target: bus.eventBusArn,
            sourceParameters: {
              sqsQueueParameters: {
                  batchSize: 1,
              },
              filterCriteria: {
                  filters: [
                      {
                          pattern: `
                      {
                          "body": {
                              "severity": ["High"]
                          }
                      }`,
                      },
                  ],
              },
          },
            targetParameters: {
              eventBridgeEventBusParameters: {
                  detailType: "RiskEventTriggered",
                  source: highRiskQ.queueArn,
              },
           
          }
        });


        const rule = new events.Rule(this, "SampleEvent-Rule", {
          eventPattern: {
              detailType: ["RiskEventTriggered"],
          },
          ruleName: "sample-event-triggered-rule",
          eventBus: bus,
      });
      const roleEvent = new iam.Role(this, "SameEventTriggered-Role", {
        assumedBy: new ServicePrincipal("events.amazonaws.com"),
      });

     
    const statesrole = new iam.Role(this, "StateMachineRole", {
      assumedBy: new ServicePrincipal(`states.amazonaws.com`),
    });

        const publishMessage = new tasks.SnsPublish(this, 'Publish message', {
          topic: new sns.Topic(this, 'notifyTopicc'),
          message: stepfunctions.TaskInput.fromJsonPathAt('$'),
          resultPath: '$.sns',
        });
        const date = new Date();

        
        const invokeS3PutObject = new tasks.CallAwsService(this, 'SendCustomEvent', {
          service: 's3',
          action: 'putObject',
          parameters: {
            
            Body:stepfunctions.TaskInput.fromJsonPathAt('$.detail'),
            Bucket: destinationBucket.bucketName,
            'Key.$': "States.Format('{}.txt', $.time)"
          },
          iamResources: [destinationBucket.arnForObjects('*')],
        });

        const jobFailed = new stepfunctions.Fail(this, 'Job Failed', {
          cause: 'AWS Batch Job Failed',
          error: 'DescribeJob returned FAILED',
        });
        const jobSucceed = new stepfunctions.Succeed(this, 'Risk Stored and notification sent');

        function buildStateMachine(scope: Construct): stepfunctions.IChainable{
          const parallel = new stepfunctions.Parallel(scope, 'Do the work in parallel');
          parallel.branch(publishMessage);
          parallel.branch(invokeS3PutObject)
         

          return parallel;
        };
        const flow = buildStateMachine(scope);
        const logGroup = new logs.LogGroup(this, "CloudwatchLogs", {
          logGroupName: "/aws/vendedlogs/states/sample-state-machine",
      });

    const stateMachine = new stepfunctions.StateMachine(this, "StateMachine", {
        role: statesrole,
        stateMachineName: "RiskStateMachine",
        definition: flow,
        stateMachineType: stepfunctions.StateMachineType.EXPRESS,
        logs: {
          destination: logGroup,
          includeExecutionData: true,
      },
       
    });
    stateMachine.addToRolePolicy(new iam.PolicyStatement({
      resources: [destinationBucket.bucketArn, `${destinationBucket.bucketArn}/*`], // this includes the bucket itself and all its objects
      actions: [
          "s3:GetObject",
          "s3:PutObject",
      ],
      effect: iam.Effect.ALLOW
  }));

    rule.addTarget(
      new SfnStateMachine(stateMachine, {
         
         
          role: roleEvent,
      })
  );
    }
  if(props && props?.infrastack == true){

        // VPC
        const vpc = new ec2.Vpc(this, 'Vpc', {
          ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
          maxAzs: 2,
          natGateways:1,
          createInternetGateway:true,
          subnetConfiguration:[{
            name: 'private',
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
          {
            name: 'public',
            subnetType: ec2.SubnetType.PUBLIC,
          },
          ]
        });
        const rolefluent = new iam.Role(this, "eksTriggered-Role", {
          assumedBy: new ServicePrincipal("eks.amazonaws.com"),
        });
       
       const cronPol = new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["*"], // Allow all actions
          resources: ["*"] // Allow all resources
        })
       rolefluent.addToPrincipalPolicy(cronPol)
        const userArn = 'arn:aws:iam::137065650613:user/pieter';
          // masters role
          const masterRole = new iam.Role(this, 'cluster-master-role', {
            assumedBy: new iam.ArnPrincipal('arn:aws:iam::137065650613:user/pieter')
          });
          const user =  iam.User.fromUserArn(this,'riskUser','arn:aws:iam::137065650613:user/pieter');
          
          
           // Create a EKS cluster with Fargate profile.
          const Riskcluster = new eks.FargateCluster(this, 'risk-cluster', {
            version: eks.KubernetesVersion.V1_27,
            mastersRole: masterRole,
            clusterName: "regulatory-risk",
            outputClusterName: true,
            albController: {
              version: eks.AlbControllerVersion.V2_5_1,
            },
            kubectlLayer: new k8sLayer.KubectlV27Layer(this, 'kubectl'),
            endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE, 
            vpc: vpc,
            vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS  },{ subnetType: ec2.SubnetType.PUBLIC  }] 
           
          });
          
          
          
          const snsPolicy = new iam.PolicyStatement({
            actions: ['sns:Publish', 'sns:Subscribe', /* other necessary SNS actions */],
            resources: ['*'],  // or specify ARNs of specific SNS topics
          });

        Riskcluster.awsAuth.addUserMapping(user,{groups:['system:masters']});

        const rdsMasterUserSecret = new Secret(this, 'rdssecret', {
          secretName: 'rdssecret',
          description: 'RDS Master User Credentials',
          generateSecretString: {
            secretStringTemplate: JSON.stringify({ username: 'sa'}),
            generateStringKey: "password",
            excludeCharacters: '/@"',
            passwordLength: 16,
          }
        });
       
        rdsMasterUserSecret.grantRead(Riskcluster.adminRole);
       
        const dbInstance = new rds.DatabaseInstance(this, 'RiskDBInstance', {
          engine: rds.DatabaseInstanceEngine.SQL_SERVER_EX,
          licenseModel: rds.LicenseModel.LICENSE_INCLUDED,
          vpc:vpc,
          multiAz: false,
        allocatedStorage: 20,
        maxAllocatedStorage: 20,
          instanceIdentifier:`st-risk-rds`,
          vpcSubnets: {
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
          allowMajorVersionUpgrade: false,
          autoMinorVersionUpgrade: true,
          backupRetention: cdk.Duration.days(0),
          deleteAutomatedBackups: true,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          deletionProtection: false,
          publiclyAccessible: false,
          instanceType: ec2.InstanceType.of(
            ec2.InstanceClass.T3,
            ec2.InstanceSize.SMALL,
          ),
          credentials: {
            username: rdsMasterUserSecret.secretValueFromJson('username').unsafeUnwrap(),
            password: rdsMasterUserSecret.secretValueFromJson('password')
          },
        
        });
        rdsMasterUserSecret.attach(dbInstance);
        // const host = new ec2.BastionHostLinux(this, 'BastionHost', {
        //   vpc
        // });
        
       
        dbInstance.connections.allowDefaultPortFrom(Riskcluster.clusterSecurityGroup);
      

          const namespace = Riskcluster.addManifest('risk-namespace', {
            apiVersion: "v1",
            kind: "Namespace",
            metadata: {
                name: "risk"
            }
        });
        
        const fargateProfileRisk = Riskcluster.addFargateProfile('FargateRiskProfile', {
          fargateProfileName: 'RegulatoryRisk',
          selectors: [{ 'namespace': 'risk' }],
          // podExecutionRole:cronPol
         
        });
        const serviceAccount = Riskcluster.addServiceAccount('ServiceAccount', {
          name: 'eso-service-account',
          namespace: 'risk'
        });
        const cronServiceAccount = Riskcluster.addServiceAccount('cronServiceAccount', {
          name: 'cron-service-account',
          namespace: 'risk'
        });
        cronServiceAccount.addToPrincipalPolicy(snsPolicy);
        serviceAccount.node.addDependency(namespace);
        cronServiceAccount.node.addDependency(namespace);
            // HELM CHART FOR EXTERNAL SECRETS
            const externalSecretsOperator = Riskcluster.addHelmChart('ExternalSecretsOperator', {
                chart: 'external-secrets',
                release: 'external-secrets',
                repository: 'https://charts.external-secrets.io',
                namespace: 'external-secrets',
                createNamespace: true,
                values: {
                  installCRDs: true,
                  webhook: {
                    port: 9443
                  }
                },
                wait: true
              });
              const fargateProfile = Riskcluster.addFargateProfile('FargateExternalSecretsProfile', {
                fargateProfileName: 'externalsecrets',
                selectors: [{ 'namespace': 'external-secrets' }]
              });
        const secretSTore = Riskcluster.addManifest('risk-secretstore', {
          apiVersion: "external-secrets.io/v1beta1",
          kind: "SecretStore",
          metadata: {
              name: "eso-secret-store",
              namespace: "risk"
          },
          spec: {
              provider: {
                  aws: {
                      service: "SecretsManager",
                      region: "af-south-1",
                      auth: {
                          jwt: {
                              serviceAccountRef: {
                                  name: "eso-service-account"
                              }
                          }
                      }
                  }
              }
          }
      });
        const externalSecret = Riskcluster.addManifest('risk-externalSecrets', {
          apiVersion: "external-secrets.io/v1beta1",
          kind: "ExternalSecret",
          metadata: {
              name: "eso-external-secret",
              namespace: "risk"
          },
          spec: {
              refreshInterval: "1h",
              secretStoreRef: {
                  name: "eso-secret-store",
                  kind: "SecretStore"
              },
              target: {
                  name: "apisecret",
                  creationPolicy: "Owner"
              },
              data: [
                  {
                      secretKey: "PASSWORD", // moet nog chnage https://medium.com/@james.kelleher.3345/how-i-set-up-the-external-secrets-operator-on-eks-using-just-cdk-a056c2339c46
                      remoteRef: {
                          key: "rdssecret",
                          property: "password"
                      }
                  }
                  ,
                  {
                    secretKey: "PORT", // moet nog chnage https://medium.com/@james.kelleher.3345/how-i-set-up-the-external-secrets-operator-on-eks-using-just-cdk-a056c2339c46
                    remoteRef: {
                        key: "rdssecret",
                        property: "port"
                    }
                }
                  ,
                  {
                    secretKey: "ID", // moet nog chnage https://medium.com/@james.kelleher.3345/how-i-set-up-the-external-secrets-operator-on-eks-using-just-cdk-a056c2339c46
                    remoteRef: {
                        key: "rdssecret",
                        property: "dbInstanceIdentifier"
                    }
                }
                  ,
                  {
                    secretKey: "HOST", // moet nog chnage https://medium.com/@james.kelleher.3345/how-i-set-up-the-external-secrets-operator-on-eks-using-just-cdk-a056c2339c46
                    remoteRef: {
                        key: "rdssecret",
                        property: "host"
                    }
                }
                 
              
              ]
          }
      });
        externalSecret.node.addDependency(externalSecretsOperator);
         
        serviceAccount.addToPrincipalPolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'secretsmanager:GetSecretValue',
            'secretsmanager:DescribeSecret'
          ],
          resources: [
            `arn:aws:secretsmanager:${props?.env?.region}:${props?.env?.account}:secret:*`
          ]
        }));
       externalSecret.node.addDependency(namespace);
          secretSTore.node.addDependency(externalSecretsOperator);
      // //   // service fe
      //   const servicefe = Riskcluster.addManifest('ui-service', {
      //     apiVersion: "v1",
      //     kind: "Service",
      //     metadata: {
      //         name: "ui-service",
      //         namespace: "risk",
      //         labels: {
      //             service: "uiService"
      //         }
      //     },
      //     spec: {
      //         selector: {
      //             app: "ui"
      //         },
      //         ports: [
      //             {
      //                 protocol: "TCP",
      //                 port: 80,
      //                 targetPort: 80
      //             }
      //         ]
      //     }
      // });
      // ingress.node.addDependency(servicefe);
      //   //service be
      //   const servicebe = Riskcluster.addManifest('be-service',{
      //     apiVersion: "v1",
      //     kind: "Service",
      //     metadata: {
      //         name: "be-service",
      //         namespace: "risk",
      //         labels: {
      //             service: "beService"
      //         }
      //     },
      //     spec: {
      //         selector: {
      //             app: "be"
      //         },
      //         ports: [
      //             {
      //                 protocol: "TCP",
      //                 port: 80,
      //                 targetPort: 80
      //             }
      //         ]
      //     }
      // });
      // servicebe.node.addDependency(namespace);
      // servicefe.node.addDependency(namespace);
      // Riskcluster
      // .addHelmChart('ArgoCD', {
      //   chart: 'argo-cd',
      //   release: 'argocd',
      //   repository: 'https://argoproj.github.io/argo-helm',
      //   namespace: 'argocd',
      // });
      // kubectl port-forward svc/argocd-server -n argocd 8080:443

    
    

    }

  }


}
// 