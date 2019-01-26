const axios = require('axios');
const mqtt = require('async-mqtt');
const config = require('./config');
const Docker = require('dockerode');


class Agent {
    constructor() {
        /* internal vars */
        console.log(">>>", config)
        this.mqttConnected = false;
        this.docker = null;
        /* Containers and apps*/
        this.contaners = []
        this.apps = []
        /* some constants */
        this.logTopic = `agents/${config.agentId}/log`;
        this.commandTopic = `agents/${config.agentId}/command`;
        this.notifyTopic = `agents/${config.agentId}/notify`;

        /* */
        this.client = mqtt.connect(config.foraMQTT, {
            username: config.agentId,
            password: config.agentToken,
            will: {
                topic: `agents/${config.agentId}/online`,
                payload: "false",
                retain: true
            }
        });
        this.onForaMessage = this.onForaMessage.bind(this);
        this.onForaConnected = this.onForaConnected.bind(this);
        this.onForaReconnect = this.onForaReconnect.bind(this);
        this.onForaDisconnect = this.onForaDisconnect.bind(this);
        this.onForaOffline = this.onForaOffline.bind(this);
        this.runApp = this.runApp.bind(this);

        this.client.on('message', this.onForaMessage )
        this.client.on('connect', this.onForaConnected )
        this.client.on('reconnect', this.onForaReconnect )
        this.client.on('disconnect', this.onForaDisconnect )
        this.client.on('offline', this.onForaOffline )
        this.client.on('error', this.onForaError)   
    }

    async start(){
        /*
        const result = await axios({
            method: 'POST',
            url: `${config.foraAPI}/api/v1/apps/${config.agentId}/setConfigSchema`, 
            data: {config: configurationSchema},
            headers: { 
                'Authorization': `Bearer ${config.appToken}`
            }
        });
        */
        this.readConfig();
        
       
    }
   
    async log(message, level) {
        if (this.mqttConnected) {
            await this.client.publish(this.logTopic, message)
            console.log(message)
        } else {
            console.log("Not connected log: ", message)
        }
    }

    onForaConnected() {
        this.mqttConnected = true;
        console.log("Connected to Fora")
        this.log('MQTT is connected')
        this.client.publish(`agents/${config.agentId}/online`, "true", {retain: true})
        this.client.subscribe(this.commandTopic)
        this.client.subscribe(this.notifyTopic)
        this.log('Subscribed to command topic: '+ this.commandTopic)
    }
    
    onForaError(error) {
        console.log("MQTT ERROR: ", error);
    }
    
    onForaReconnect() {
        this.log('MQTT reconnect attempt')
    }

    onForaDisconnect() {
        this.mqttConnected = false;
        this.log('MQTT disconnected')
    }

    onForaOffline() {
        this.mqttConnected = false;
        this.log('MQTT is offline')
    }

    async readDockerContainers() {
        this.docker.listContainers({all: true}).then(async list=>{
            this.containers = list;
            await axios({
                method: 'PUT',
                url: `${config.foraAPI}/api/v1/agents/${config.agentId}/containers`, 
                headers: { 
                    'Authorization': `Bearer ${config.agentToken}`
                },
                data: list
            });
            
            console.log("containers published")
        }).catch(e=>{console.log("ERROR: ",e)})
    }

    async readDockerImages() {
        this.docker.listImages({all: true}).then(list=>{
            console.log("IMAGES:", list)
        }).catch(e=>{console.log("ERROR: ",e)})
    }

    async runApp(app) {
        
      
        const container = this.containers.find(c=>c.Names.indexOf(`/${app._id}`)>-1)
        if (!container) {
            console.log("START APP", app)
            // LETS GET TOKEN!
            

            const result = await axios({
                method: 'POST',
                url: `${config.foraAPI}/api/v1/apps/${app._id}/generateAccessKey`, 
                headers: { 
                    'Authorization': `Bearer ${config.agentToken}`
                }
            });

            const appToken = result.data.token;

            this.createAppContainer({
                image: app.image, 
                name: app._id, 
                isHostNetwork: app.isHostNetwork,
                envs: [`FORA_APP_ID=${app._id}`, `FORA_APP_TOKEN=${appToken}`,...(app.envs||[])]
            })
        }
    }

    async reloadApps() {
        try {
            console.log("---->>> LOADING APPS")
            const result = await axios({
                method: 'GET',
                url: `${config.foraAPI}/api/v1/agents/${config.agentId}/apps`, 
                headers: { 
                    'Authorization': `Bearer ${config.agentToken}`
                }
            });

            this.apps = result.data;
            console.log("AGENT APPS DATA: ", result.data)
            
            this.apps.forEach(app=>{this.runApp(app)})

        } catch (error) {
            console.log("AGENT APPS ERROR: ", error.message)
        }

    }

    async readDockerInfo() {
        this.docker.info().then(async info=>{
            await axios({
                method: 'PUT',
                url: `${config.foraAPI}/api/v1/agents/${config.agentId}/info`, 
                headers: { 
                    'Authorization': `Bearer ${config.agentToken}`
                },
                data: info
            });
            console.log("info published")
        }).catch(e=>{console.log("ERROR: ",e)})

        
    }

    monitorDocker() {
        const self = this;
        this.docker.getEvents({}, function (err, data) {
            if(err){
                console.log(err.message);
            } else {
                data.on('data', function (chunk) {
                    const event = JSON.parse(chunk.toString('utf8'));
                    
                    if (event.Type === 'container') {
                        self.readDockerContainers()
                        self.log(`${event.Type} ${event.Action}: ${JSON.stringify((event.Actor||{}).Attributes)}`)
                    } else {
                        self.log(`${event.Type} ${event.Action}`)
                    }
                });
            } 
        });
    }

    async readConfig() {
        /*
        try {
            const result = await axios({
                method: 'GET',
                url: `${config.foraAPI}/api/v1/agents/${config.agentId}`, 
                headers: { 
                    'Authorization': `Bearer ${config.agentToken}`
                }
            });

            this.config = result.data;
            console.log("AGENT CONFIGURATION DATA: ", result.data)
            
        } catch (error) {
            console.log(error.message)
        }
        */

        this.docker = new Docker({socketPath: '/var/run/docker.sock'});
        this.monitorDocker()
        this.readDockerInfo()
        await this.readDockerContainers()
        this.reloadApps()
        // this.readDockerImages()
    }

    async createAppContainer(app) {
        // app: Image: app.image, name: app._id, co
        this.docker.pull(app.image, (err, stream)=>{
            console.log(stream.complete, Object.keys(stream))
            this.docker.modem.followProgress(stream, (err, output)=>{

                let config = {name: app.name, Env: app.envs};
                if (app.isHostNetwork) {
                    config.NetworkMode = 'host'
                }
                console.log("---")
                this.docker.run(app.image, [], null, config).then(async (container) => {
                    console.log("CREATED!!!", container)  
                  }).catch(function(err) {
                    console.log("ERROR CREATING", err);
                  });
            }, (event)=>{
                this.log(`${event.status}:${event.id}`)
            })
           


            

        })
        
        
   
            


        
    }

    async onForaMessage(topic, message) {

        //console.log(">>>>>>>>>>>>>FORA MESSAGE", topic, message.toString())
        if (topic === this.commandTopic) {
            console.log("Command topic received", message.toString())
            const command = JSON.parse(message.toString()) || {}
            
            if (command.containerId) {
                let container = this.docker.getContainer(command.containerId)
                if (command.action === 'start') {
                    container.start()
                }
                
                if (container && command.action === 'stop') {
                    container.stop()  
                }
    
                if (container && command.action === 'remove') {
                    container.remove()
                }
            }
            // if (command.image && command.action === 'runContainer') {
            //     this.createAppContainer({image: command.image})
            // }
        }
    
        if (topic === this.notifyTopic) {
            //console.log("Notify topic received")
            if (message.toString()==="reloadContainers") {
                this.readDockerContainers()
            }
            if (message.toString()==="reloadInfo") {
                this.readDockerInfo()
            } 
            if (message.toString()==="reloadApps") {
                this.reloadApps()
            }  
        }

        //let found = this.subscibedTopics.find(st=>st.topic===topic)
        //console.log("###############################",found)
        // if (found) {
 
        // }
       
    }

}





const app = new Agent();
app.start()

